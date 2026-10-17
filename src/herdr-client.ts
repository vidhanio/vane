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

export class HerdrSubscription {
  private version = 0;
  private failure: Error | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly disconnect: () => void) {}

  get revision(): number {
    if (this.failure) throw this.failure;
    return this.version;
  }

  changed(): void {
    this.version++;
    this.wake?.();
  }

  failed(error: Error): void {
    this.failure ??= error;
    this.wake?.();
  }

  async wait(revision: number, timeout: number | undefined, context: Context): Promise<void> {
    context.abortSignal?.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.revision !== revision) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const signal = context.abortSignal;
    const wake = () => this.wake?.();
    try {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        signal?.addEventListener("abort", wake, { once: true });
        if (timeout !== undefined) timer = setTimeout(resolve, Math.max(0, timeout));
      });
      signal?.throwIfAborted();
      if (this.failure) throw this.failure;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", wake);
      this.wake = undefined;
    }
  }

  close(): void {
    this.disconnect();
  }
}

/** Targets the Herdr v0.9.5 socket API. */
export class HerdrClient {
  constructor(readonly socketPath: string) {}

  async subscribe(pane: string, context: Context): Promise<HerdrSubscription> {
    context.abortSignal?.throwIfAborted();
    const id = randomUUID();
    const socket = createConnection({ path: this.socketPath, signal: context.abortSignal });
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    const subscription = new HerdrSubscription(() => {
      lines.close();
      socket.destroy();
    });
    const responseSchema = z.union([
      z.object({ id: z.literal(id), error: z.object({ code: z.string(), message: z.string() }) }),
      z.object({
        id: z.literal(id),
        result: z.object({ type: z.literal("subscription_started") }),
      }),
      z.object({
        event: z.enum(["pane.agent_status_changed", "pane.closed", "pane.exited"]),
        data: z.object({ pane_id: z.string() }),
      }),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => {
          subscription.failed(error);
          reject(error);
          subscription.close();
        };
        socket.on("error", fail);
        lines.on("error", fail);
        socket.on("close", () => fail(new Error("Herdr event subscription disconnected")));
        timer = setTimeout(
          () => fail(new HerdrError("timeout", "Herdr event subscription setup timed out")),
          35_000,
        );
        socket.once("connect", () => {
          socket.write(
            `${JSON.stringify({
              id,
              method: "events.subscribe",
              params: {
                subscriptions: [
                  { type: "pane.agent_status_changed", pane_id: pane },
                  { type: "pane.closed" },
                  { type: "pane.exited" },
                ],
              },
            })}\n`,
          );
        });
        lines.on("line", (line) => {
          try {
            if (line.length > 1_000_000) throw new Error("Herdr response exceeded 1 MB");
            const response = responseSchema.parse(JSON.parse(line));
            if ("error" in response)
              throw new HerdrError(response.error.code, response.error.message);
            if ("result" in response) {
              clearTimeout(timer);
              resolve();
            } else if (response.data.pane_id === pane) subscription.changed();
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
      return subscription;
    } catch (error) {
      subscription.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async request<K extends keyof Methods>(
    method: K,
    params: Methods[K],
    context: Context,
    timeout = 35_000,
  ): Promise<unknown> {
    context.abortSignal?.throwIfAborted();
    const id = randomUUID();
    const responseSchema = z.union([
      z.object({ id: z.literal(id), error: z.object({ code: z.string(), message: z.string() }) }),
      z.object({ id: z.literal(id), result: z.unknown() }),
    ]);
    const socket = createConnection({ path: this.socketPath, signal: context.abortSignal });
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure = error;
      lines.close();
    };
    socket.on("error", fail);
    lines.on("error", fail);
    const timer = setTimeout(
      () => socket.destroy(new HerdrError("timeout", "Herdr socket request timed out")),
      timeout,
    );
    try {
      await once(socket, "connect");
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
      for await (const line of lines) {
        if (line.length > 1_000_000) throw new Error("Herdr response exceeded 1 MB");
        const response = responseSchema.parse(JSON.parse(line));
        if ("error" in response) throw new HerdrError(response.error.code, response.error.message);
        return response.result;
      }
      context.abortSignal?.throwIfAborted();
      throw failure ?? new Error("Herdr socket disconnected");
    } finally {
      clearTimeout(timer);
      lines.close();
      socket.destroy();
    }
  }
}
