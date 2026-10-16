import type { Context } from "@earendil-works/chord";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { z } from "zod";

interface Methods {
  "agent.list": Record<string, never>;
  "agent.get": { target: string };
  "agent.read": { target: string; source: "visible" | "recent_unwrapped"; lines: number };
  "agent.start": {
    name: string;
    kind: "pi";
    pane_id: string;
    timeout_ms: number;
  };
  "agent.prompt": { target: string; text: string };
  "workspace.list": Record<string, never>;
  "workspace.create": { cwd: string; label: string; focus: false };
  "pane.list": { workspace_id: string };
  "pane.get": { pane_id: string };
  "pane.close": { pane_id: string };
  "tab.create": { workspace_id: string; cwd: string; label: string; focus: false };
}

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Targets the Herdr v0.9.5 socket API. */
export class HerdrClient {
  constructor(readonly socketPath: string) {}

  private async *exchange(method: string, params: object, context: Context, timeout: number) {
    context.abortSignal?.throwIfAborted();
    const id = randomUUID();
    const socket = createConnection({
      path: this.socketPath,
      ...(context.abortSignal ? { signal: context.abortSignal } : {}),
    });
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    let failure: Error | undefined;
    socket.on("error", (error) => {
      failure = error;
      lines.close();
    });
    const timer = setTimeout(
      () => socket.destroy(new HerdrError("timeout", "Herdr socket request timed out")),
      timeout,
    );
    try {
      await once(socket, "connect");
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
      for await (const line of lines) {
        if (line.length > 1_000_000) throw new Error("Herdr response exceeded 1 MB");
        const frame: unknown = JSON.parse(line);
        const responseId = z.object({ id: z.string() }).safeParse(frame);
        if (responseId.success && responseId.data.id !== id)
          throw new Error("Herdr response ID does not match the request");
        const error = z
          .object({ id: z.literal(id), error: z.object({ code: z.string(), message: z.string() }) })
          .safeParse(frame);
        if (error.success) throw new HerdrError(error.data.error.code, error.data.error.message);
        yield frame;
      }
      throw failure ?? new Error("Herdr socket disconnected");
    } finally {
      clearTimeout(timer);
      lines.close();
      socket.destroy();
    }
  }

  async request<K extends keyof Methods>(
    method: K,
    params: Methods[K],
    context: Context,
    timeout = 35_000,
  ): Promise<unknown> {
    for await (const frame of this.exchange(method, params, context, timeout))
      return z.object({ id: z.string(), result: z.unknown() }).parse(frame).result;
    throw new Error("Herdr did not respond");
  }
}
