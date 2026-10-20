import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cachePayload(payload: unknown): unknown {
  if (!object(payload) || !Array.isArray(payload.messages)) return payload;
  delete payload.cache_control;
  for (const collection of [payload.system, payload.tools])
    if (Array.isArray(collection))
      for (const block of collection) if (object(block)) delete block.cache_control;
  for (const message of payload.messages) {
    if (!object(message)) continue;
    delete message.cache_control;
    if (Array.isArray(message.content))
      for (const block of message.content) if (object(block)) delete block.cache_control;
  }
  const system = Array.isArray(payload.system) ? payload.system.at(-1) : undefined;
  if (object(system)) system.cache_control = { type: "ephemeral" };
  const compaction = object(payload.tool_choice) && payload.tool_choice.type === "none";
  let input: Record<string, unknown> | undefined;
  let shaped = false;
  for (const message of payload.messages) {
    if (!object(message) || message.role === "assistant") break;
    if (message.role !== "user") continue;
    input = message;
    if (shaped) continue;
    const content = Array.isArray(message.content)
      ? message.content
      : [{ type: "text", text: message.content }];
    const index = content.findIndex(
      (block: unknown) =>
        object(block) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.startsWith("<chat>\n") &&
        block.text.endsWith("\n</chat>"),
    );
    if (index < 0) continue;
    const text: string = content[index].text;
    const lines = text.slice("<chat>\n".length, -"\n</chat>".length).split("\n").filter(Boolean);
    const blocks: { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[] = [
      { type: "text", text: "<chat>\n" },
    ];
    while (lines.length >= 4)
      blocks.push({ type: "text", text: lines.splice(0, 4).join("\n") + "\n" });
    const marked = blocks.at(-1);
    if (marked) marked.cache_control = { type: "ephemeral" };
    blocks.push({
      type: "text",
      text: lines.join("\n") + (lines.length || blocks.length === 1 ? "\n" : "") + "</chat>",
    });
    content.splice(index, 1, ...blocks);
    message.content = content;
    shaped = true;
  }
  if (!compaction) {
    if (input) {
      if (typeof input.content === "string")
        input.content = [{ type: "text", text: input.content }];
      const last = Array.isArray(input.content) ? input.content.at(-1) : undefined;
      if (object(last)) last.cache_control = { type: "ephemeral" };
    }
    payload.cache_control = { type: "ephemeral" };
  }
  return payload;
}

export function cacheKeys(payload: unknown, identity: string): string[] {
  if (!object(payload) || !Array.isArray(payload.messages)) return [];
  const head = { ...payload };
  for (const field of ["messages", "max_tokens", "stream", "cache_control", "metadata"])
    delete head[field];
  let hash = Bun.hash(JSON.stringify([identity, head]));
  const keys: string[] = [];
  let view = false;
  for (const message of payload.messages) {
    if (!object(message)) continue;
    const content = Array.isArray(message.content) ? message.content : [message.content];
    for (const block of content) {
      if (object(block) && block.type === "text" && typeof block.text === "string")
        view ||= block.text.startsWith("<chat>\n");
      const value = object(block) ? { ...block } : block;
      if (object(value)) delete value.cache_control;
      hash = Bun.hash(JSON.stringify([message.role, value]), hash);
      keys.push(String(hash));
      if (view && object(block) && block.cache_control) return keys;
    }
  }
  return [];
}

const noop = () => {};
export type Flight = { begun: () => void; end: () => void };
type Cached = { until: number; ready: Promise<void> | undefined };

export class CacheGate {
  private readonly cached = new Map<string, Cached>();

  async enter(keys: string[], signal?: AbortSignal): Promise<Flight> {
    const key = keys.at(-1);
    if (!key) return { begun: noop, end: noop };
    for (;;) {
      signal?.throwIfAborted();
      const now = Date.now();
      for (const [cachedKey, entry] of this.cached)
        if (!entry.ready && entry.until <= now) this.cached.delete(cachedKey);
      const hit = keys.findLast((candidate) => this.cached.has(candidate));
      const entry = hit === undefined ? undefined : this.cached.get(hit);
      if (entry?.ready) {
        await awaitWithContext(
          entry.ready,
          signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
        );
        continue;
      }
      if (entry) entry.until = now + 300_000;
      if (hit === key) return { begun: noop, end: noop };
      let release = noop;
      const own: Cached = {
        until: 0,
        ready: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      this.cached.set(key, own);
      return {
        begun: () => {
          if (!own.ready) return;
          own.ready = undefined;
          own.until = Date.now() + 300_000;
          release();
        },
        end: () => {
          if (!own.ready) return;
          if (this.cached.get(key) === own) this.cached.delete(key);
          own.ready = undefined;
          release();
        },
      };
    }
  }
}
