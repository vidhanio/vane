import type { ToolCall } from "@earendil-works/pi-ai";
import type { Reply } from "../attachments.ts";
import type { MessageOrigin } from "../messages.ts";

export type ToolActivity = Pick<ToolCall, "id" | "name" | "arguments"> & { details?: unknown };

export interface DirectMessageIntegration {
  readonly name: string;
  setTyping(origin: MessageOrigin | undefined): void;
  progress(
    origin: MessageOrigin,
    calls: ToolActivity[],
    ids: string[],
    key: string,
  ): Promise<string[]>;
  removeProgress(origin: MessageOrigin, ids: string[]): Promise<void>;
  reply(origin: MessageOrigin, message: Reply, key: string): Promise<void>;
}

export interface Platform extends DirectMessageIntegration {
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
