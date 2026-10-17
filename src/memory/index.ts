import { EventEmitter } from "node:events";
import { Mutex } from "async-mutex";
import { Store, type Kind, type Record } from "./store.ts";
import { bytes, children, end, key, label, parent, start, View, type Part } from "./view.ts";

type Compression = { part: Part; source: string; view: string };
export type Compressor = (input: Compression, signal: AbortSignal) => Promise<string>;

export function split(text: string): string[] {
  const parts: string[] = [];
  let part = "";
  let size = 0;
  for (const character of text) {
    const length = bytes(character);
    if (size + length > 30_000) {
      parts.push(part);
      part = "";
      size = 0;
    }
    part += character;
    size += length;
  }
  if (part || !parts.length) parts.push(part);
  return parts;
}

export function clip(text: string): string {
  const characters = Array.from(text);
  if (characters.length <= 30_000) return text;
  const notice = `\n[${characters.length - 14_950 * 2} characters omitted; head and tail retained]\n`;
  return characters.slice(0, 14_950).join("") + notice + characters.slice(-14_950).join("");
}

export class Memory {
  readonly store: Store;
  readonly chat: View;
  private readonly compaction: View;
  private readonly lock = new Mutex();
  private readonly events = new EventEmitter();
  private readonly controller = new AbortController();
  private readonly leaves = new Set<number>();
  private readonly merges = new Map<string, Part>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly failed = new Set<string>();
  private frontier = 0;
  private scheduled = false;
  private stopped = false;
  private fatal: unknown;

  private constructor(
    directory: string,
    private readonly compress: Compressor,
  ) {
    this.store = new Store(directory);
    this.chat = new View(128_000, 64_000, (part) => this.store.nodes.get(key(part)));
    this.compaction = new View(32_000, 16_000, (part) => this.store.nodes.get(key(part)));
  }

  static async open(directory: string, compress: Compressor): Promise<Memory> {
    const memory = new Memory(directory, compress);
    const saved = await memory.store.load();
    if (!saved && memory.store.records.length)
      throw new Error("Missing memory view; refusing to rebuild it from the log");
    if (saved) {
      memory.chat.parts = saved.parts;
      memory.chat.merging = saved.merging;
      memory.compaction.parts = saved.compaction;
      memory.compaction.merging = saved.compacting;
    }
    for (const view of [memory.chat, memory.compaction]) {
      const last = view.parts.at(-1);
      const covered = last ? end(last) : 0;
      for (let i = covered; i < memory.store.records.length; i++) view.parts.push([0, i]);
    }
    for (let i = 0; i < memory.store.records.length; i++)
      if (!memory.store.nodes.has(key([0, i]))) memory.leaves.add(i);
    for (const node of memory.store.nodes.values()) memory.queueParent([node.l, node.i]);
    memory.advance();
    await memory.save();
    memory.schedule();
    return memory;
  }

  async append(
    kind: Kind,
    text: string,
    date: string,
    receipt: string,
    source: Record["source"],
  ): Promise<number> {
    return this.lock.runExclusive(async () => {
      this.check();
      const existing = this.store.receipts.get(receipt);
      if (existing !== undefined) return existing;
      const i = this.store.records.length;
      try {
        await this.store.appendRecord({
          i,
          kind,
          text,
          size: bytes(`${kind}: ${text}`),
          date,
          receipt,
          source,
        });
        this.chat.parts.push([0, i]);
        this.compaction.parts.push([0, i]);
        this.leaves.add(i);
        this.failed.clear();
        await this.save();
      } catch (error) {
        this.fatal = error;
        this.events.emit("change");
        throw error;
      }
      this.schedule();
      return i;
    });
  }

  private check(): void {
    if (this.stopped) throw new Error("Memory is closed");
    if (this.fatal) throw this.fatal;
  }

  private save(): Promise<void> {
    const merged = this.chat.fit(this.store.records.length);
    this.compaction.fit(this.store.records.length, merged);
    return this.store.save({
      nodes: this.store.nodes.size,
      parts: this.chat.parts,
      merging: this.chat.merging,
      compaction: this.compaction.parts,
      compacting: this.compaction.merging,
    });
  }

  private advance(): void {
    while (
      this.frontier < this.store.records.length &&
      this.store.nodes.has(key([0, this.frontier]))
    )
      this.frontier++;
  }

  private queueParent(part: Part): void {
    const merged = parent(part);
    if (
      !this.store.nodes.has(key(merged)) &&
      children(merged).every((child) => this.store.nodes.has(key(child)))
    )
      this.merges.set(key(merged), merged);
  }

  private schedule(): void {
    if (this.scheduled || this.stopped || this.fatal) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.stopped || this.fatal) return;
    const run = (part: Part) => {
      const id = key(part);
      if (this.active.has(id) || this.failed.has(id)) return;
      const work = this.build(part)
        .catch((error: unknown) => {
          this.failed.add(id);
          if (!this.stopped) console.error(`Memory compaction ${label(part)} failed`, error);
        })
        .finally(() => {
          this.active.delete(id);
          this.schedule();
          this.events.emit("change");
        });
      this.active.set(id, work);
    };
    let ahead = 0;
    for (const i of this.leaves) {
      if (ahead++ >= 8 || this.active.size >= 8) break;
      run([0, i]);
    }
    for (const part of this.merges.values()) {
      if (this.active.size >= 8) break;
      run(part);
    }
    this.events.emit("change");
  }

  private async build(part: Part): Promise<void> {
    const [l, i] = part;
    let source: string;
    if (l === 0) {
      const record = this.store.records[i];
      if (!record) throw new Error("Missing source message");
      source = `${record.kind}: ${record.text}`;
    } else {
      source = children(part)
        .map((child) => {
          const node = this.store.nodes.get(key(child));
          if (!node) throw new Error("Missing child summary");
          return node.text;
        })
        .join("\n");
    }
    const boundary = Math.min(this.frontier, l === 0 ? start(part) : end(part));
    const text =
      bytes(source) <= 512
        ? source
        : (
            await this.compress(
              { part, source, view: this.compaction.render(boundary) },
              this.controller.signal,
            )
          ).trim();
    if (!text) throw new Error("Compactor returned an empty summary");
    if (this.stopped) return;
    await this.lock.runExclusive(async () => {
      this.check();
      try {
        await this.store.appendNode({ l, i, text, size: bytes(text) });
        if (l === 0) this.leaves.delete(i);
        this.merges.delete(key(part));
        this.failed.delete(key(part));
        this.queueParent(part);
        this.advance();
        await this.save();
      } catch (error) {
        this.fatal = error;
        throw error;
      }
    });
  }

  async settle(boundary: number, signal?: AbortSignal): Promise<void> {
    this.check();
    if (this.frontier >= boundary) return;
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.events.off("change", check);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(new Error("Memory wait cancelled"));
      };
      const check = () => {
        if (this.stopped || signal?.aborted) {
          abort();
          return;
        }
        if (
          this.fatal ||
          (this.frontier < boundary && !this.active.size && !this.scheduled && this.failed.size)
        ) {
          cleanup();
          reject(
            this.fatal ?? new Error("Memory summaries are unavailable; retry on the next message"),
          );
        } else if (this.frontier >= boundary) {
          cleanup();
          resolve();
        }
      };
      this.events.on("change", check);
      signal?.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  retry(): void {
    this.failed.clear();
    this.schedule();
  }

  zoom(id: number, n: number, offset = 0): string {
    if (
      !Number.isSafeInteger(id) ||
      id < 0 ||
      !Number.isSafeInteger(n) ||
      n < 1 ||
      !Number.isInteger(Math.log2(n)) ||
      id % n ||
      id + n > this.store.records.length
    )
      throw new Error(`No memory line ${id}+${n}`);
    if (n > 1) {
      if (offset) throw new Error("offset is only valid with n = 1");
      return children([Math.log2(n), id / n])
        .map((part) => this.chat.line(part))
        .join("\n");
    }
    const record = this.store.records[id];
    if (!record) throw new Error(`No memory message ${id}`);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= Math.max(1, record.text.length))
      throw new Error("Invalid message page offset");
    const from = /[\udc00-\udfff]/.test(record.text[offset] ?? "") ? offset - 1 : offset;
    let to = Math.min(record.text.length, from + 25_000);
    if (/[\ud800-\udbff]/.test(record.text[to - 1] ?? "")) to--;
    return `${id}+1|${record.kind}: ${record.text.slice(from, to)}${offset || to < record.text.length ? `\n[characters ${from}-${to} of ${record.text.length}${to < record.text.length ? `; next offset: ${to}` : ""}]` : ""}`;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    this.events.emit("change");
    await Promise.allSettled(this.active.values());
    await this.store.close();
  }
}
