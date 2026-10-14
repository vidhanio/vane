import type { ImageContent } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";

/** Identifies a session on one platform. */
export interface SessionRef {
  /** Platform name; matches the [platforms.<name>] config table. */
  readonly platform: string;
  /** The platform's own id for the session, unique within that platform. */
  readonly id: string;
}

/** A file attached to an incoming message. */
export interface Attachment {
  readonly url: string;
  readonly name?: string;
  readonly image?: ImageContent;
}

/** A message received from a platform. */
export interface IncomingMessage {
  readonly session: SessionRef;
  /** The platform's own id for this message, unique within that platform. Retries reuse it. */
  readonly id: string;
  /** Display name of the sender. */
  readonly author: string;
  readonly text: string;
  readonly attachments?: readonly Attachment[];
}

/** Tool-owned call metadata. Platforms decide how to format it. */
export type ToolCallDetails =
  | { readonly tool: "bash"; readonly command: string }
  | { readonly tool: "read"; readonly path: string }
  | { readonly tool: "write"; readonly path: string }
  | { readonly tool: "edit"; readonly path: string }
  | {
      readonly tool: "herdr";
      readonly action: "list" | "start" | "inspect" | "delegate" | "wait";
      readonly project?: string;
      readonly name?: string;
      readonly kind?: "pi" | "claude" | "codex";
      readonly agent?: string;
      readonly task?: string;
    };

/** A tool call observed while a turn is running. */
export interface ToolCallEvent {
  readonly type: "tool-call";
  readonly session: SessionRef;
  /** The provider's id for the call, stable within the turn. */
  readonly callId: string;
  readonly name: string;
  readonly status: "pending" | "running" | "done";
  /** Typed call metadata published by the tool. */
  readonly details?: ToolCallDetails;
  /** The full retained output window, not an incremental delta. */
  readonly output?: string;
  /** Tool-published structured progress or result data. */
  readonly resultDetails?: JsonValue;
}

/** Agent lifecycle events a platform may observe. */
export type BotEvent =
  | { readonly type: "turn-start"; readonly session: SessionRef }
  | ToolCallEvent
  | { readonly type: "turn-end"; readonly session: SessionRef; readonly answer?: string }
  | { readonly type: "turn-error"; readonly session: SessionRef; readonly error: unknown };

/** A session's activity, model and usage. */
export interface SessionInfo {
  readonly activity: string;
  readonly provider: string;
  readonly model: string;
  readonly thinking: string;
  readonly cwd: string;
  readonly tokens: number;
  readonly cost: number;
}

/** The agent surface every platform talks to. */
export interface PlatformHost {
  /** Run one turn and return its reply, or undefined when stopped. */
  ask(message: IncomingMessage): Promise<string | undefined>;
  /** Abort the turn running in a session, if any. */
  stop(session: SessionRef): Promise<void>;
  /** Inspect a session, or undefined when it has not started. */
  status(session: SessionRef): Promise<SessionInfo | undefined>;
  /** Observe agent lifecycle events. Returns an unsubscribe function. */
  subscribe(listener: (event: BotEvent) => void | Promise<void>): () => void;
}

/** A platform integration. */
export interface Platform {
  readonly name: string;
  /** Connect and begin delivering messages to the host. Resolves when ready. */
  start(host: PlatformHost): Promise<void>;
  /** Stop receiving and release resources, letting in-flight turns finish. */
  stop(): Promise<void>;
}

/** Builds a platform from its [platforms.<name>] config table. */
export interface PlatformDefinition {
  readonly name: string;
  create(raw: unknown): Platform;
}
