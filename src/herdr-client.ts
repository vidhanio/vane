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
    kind: "pi" | "claude" | "codex";
    pane_id: string;
    timeout_ms: number;
  };
  "agent.prompt": { target: string; text: string; wait: { timeout_ms: number } };
  "agent.wait": { target: string; timeout_ms: number };
  "workspace.create": { cwd: string; label: string; focus: false };
}

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

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

  async *watchAgent(paneId: string, context: Context, timeout = 35_000) {
    const subscriptions = [
      { type: "pane.agent_status_changed", pane_id: paneId },
      { type: "pane.scroll_changed", pane_id: paneId },
      { type: "pane.updated" },
      { type: "pane.agent_detected" },
      { type: "pane.exited" },
      { type: "pane.closed" },
    ];
    let started = false;
    for await (const frame of this.exchange(
      "events.subscribe",
      { subscriptions },
      context,
      timeout,
    )) {
      if (!started) {
        z.object({ result: z.object({ type: z.literal("subscription_started") }) }).parse(frame);
        started = true;
        yield;
      } else {
        const event = z
          .object({
            event: z.string(),
            data: z.object({
              pane_id: z.string().optional(),
              pane: z.object({ pane_id: z.string() }).optional(),
            }),
          })
          .parse(frame);
        if ((event.data.pane_id ?? event.data.pane?.pane_id) === paneId) yield;
      }
    }
  }
}
