import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { bytes, end, key, start, type Node, type Part } from "./view.ts";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const partSchema = z.tuple([integer.max(52), integer]);
const recordSchema = z.object({
  i: integer,
  kind: z.enum(["user", "vane", "tool", "echo", "work"]),
  text: z.string(),
  size: integer,
  date: z.iso.datetime(),
  receipt: z.string(),
  source: z.object({ entry: integer, message: integer }),
});
const nodeSchema = z.object({ l: integer.max(52), i: integer, text: z.string(), size: integer });
const viewSchema = z.object({
  nodes: integer,
  parts: z.array(partSchema),
  merging: z.boolean(),
  compaction: z.array(partSchema),
  compacting: z.boolean(),
});
export type Record = z.infer<typeof recordSchema>;
export type Kind = Record["kind"];
type SavedView = z.infer<typeof viewSchema>;

export class Store {
  readonly records: Record[] = [];
  readonly nodes = new Map<string, Node>();
  readonly receipts = new Map<string, number>();
  private writing: Promise<void> = Promise.resolve();
  private failure: unknown;
  private readonly files = new Set<string>();

  constructor(readonly directory: string) {}

  async load(): Promise<SavedView | undefined> {
    for (const directory of ["main", "tree"]) {
      const path = join(this.directory, directory);
      await mkdir(path, { recursive: true, mode: 0o700 });
      const files = (await readdir(path))
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .toSorted();
      for (const file of files) {
        this.files.add(join(path, file));
        const text = await readFile(join(path, file), "utf8");
        if (text && !text.endsWith("\n"))
          throw new Error(`Incomplete memory write: ${path}/${file}`);
        for (const line of text.split("\n").filter(Boolean)) {
          const value: unknown = JSON.parse(line);
          if (directory === "main") {
            const record = recordSchema.parse(value);
            if (record.i !== this.records.length || this.receipts.has(record.receipt))
              throw new Error("Noncontiguous or duplicate memory log");
            if (record.size !== bytes(`${record.kind}: ${record.text}`))
              throw new Error("Invalid memory message size");
            this.records.push(record);
            this.receipts.set(record.receipt, record.i);
          } else {
            const node = nodeSchema.parse(value);
            const part: Part = [node.l, node.i];
            if (
              end(part) > this.records.length ||
              this.nodes.has(key(part)) ||
              node.size !== bytes(node.text)
            )
              throw new Error("Invalid or duplicate memory node");
            this.nodes.set(key(part), node);
          }
        }
      }
    }
    let saved: SavedView;
    try {
      saved = viewSchema.parse(
        JSON.parse(await readFile(join(this.directory, "view.json"), "utf8")),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    if (this.nodes.size < saved.nodes) throw new Error("The memory tree is behind its saved view");
    for (const parts of [saved.parts, saved.compaction]) {
      let covered = 0;
      for (const part of parts) {
        if (
          start(part) !== covered ||
          end(part) > this.records.length ||
          (part[0] > 0 && !this.nodes.has(key(part)))
        )
          throw new Error("Saved memory view does not tile the log; refusing to rebuild it");
        covered = end(part);
      }
    }
    return saved;
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.writing.then(async () => {
      if (this.failure) throw this.failure;
      await action();
    });
    this.writing = next.catch((error: unknown) => {
      this.failure = error;
    });
    return next;
  }

  private append(directory: string, value: unknown): Promise<void> {
    return this.enqueue(async () => {
      const path = join(
        this.directory,
        directory,
        `${new Date().toISOString().slice(0, 10)}.jsonl`,
      );
      const file = await open(path, "a", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(value)}\n`);
        await file.sync();
        if (!this.files.has(path)) {
          const parent = await open(join(this.directory, directory), "r");
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
          this.files.add(path);
        }
      } finally {
        await file.close();
      }
    });
  }

  async appendRecord(record: Record): Promise<void> {
    await this.append("main", record);
    this.records.push(record);
    this.receipts.set(record.receipt, record.i);
  }

  async appendNode(node: Node): Promise<void> {
    await this.append("tree", node);
    this.nodes.set(key([node.l, node.i]), node);
  }

  save(view: SavedView): Promise<void> {
    const text = JSON.stringify(view);
    return this.enqueue(async () => {
      const path = join(this.directory, "view.json");
      const file = await open(`${path}.tmp`, "w", 0o600);
      try {
        await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(`${path}.tmp`, path);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
  }

  async close(): Promise<void> {
    await this.writing;
    if (this.failure) throw this.failure;
  }
}
