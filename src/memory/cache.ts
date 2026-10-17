function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cachePayload(payload: unknown): unknown {
  if (!object(payload) || !Array.isArray(payload.messages)) return payload;
  let marked: object | undefined;
  for (const message of payload.messages) {
    if (!object(message) || message.role !== "user" || !Array.isArray(message.content)) continue;
    const index = message.content.findIndex(
      (block: unknown) =>
        object(block) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.startsWith("<chat>\n"),
    );
    if (index < 0) continue;
    const text: string = message.content[index].text;
    const lines = text.slice("<chat>\n".length, -"\n</chat>".length).split("\n").filter(Boolean);
    const blocks: { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[] = [];
    let prefix = "<chat>\n";
    while (lines.length >= 4) {
      blocks.push({ type: "text", text: prefix + lines.splice(0, 4).join("\n") + "\n" });
      prefix = "";
    }
    const last = blocks.at(-1);
    if (last) {
      marked = last;
      last.cache_control = { type: "ephemeral" };
    }
    blocks.push({
      type: "text",
      text: prefix + lines.join("\n") + (lines.length || !blocks.length ? "\n" : "") + "</chat>",
    });
    message.content.splice(index, 1, ...blocks);
    break;
  }
  for (const collection of [payload.system, payload.tools])
    if (Array.isArray(collection))
      for (const block of collection) if (object(block)) delete block.cache_control;
  for (const message of payload.messages) {
    if (!object(message)) continue;
    delete message.cache_control;
    if (Array.isArray(message.content))
      for (const block of message.content)
        if (object(block) && block !== marked) delete block.cache_control;
  }
  payload.cache_control = { type: "ephemeral" };
  return payload;
}

const noop = () => {};

export class CacheGate {
  private readonly pending = new Map<string, Promise<void>>();

  async enter(prefix: string, signal?: AbortSignal): Promise<() => void> {
    for (;;) {
      signal?.throwIfAborted();
      const previous = [...this.pending].find(([key]) => prefix.startsWith(key))?.[1];
      if (!previous) break;
      let abort = noop;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("Cache wait cancelled"));
        signal?.addEventListener("abort", abort, { once: true });
      });
      try {
        await Promise.race([previous, cancelled]);
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    }
    let release = noop;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending.set(prefix, pending);
    return () => {
      if (this.pending.get(prefix) === pending) this.pending.delete(prefix);
      release();
    };
  }
}
