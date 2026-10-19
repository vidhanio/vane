import type { ToolCall } from "@earendil-works/pi-ai";
import type { Reply } from "../attachments.ts";
import type { MessageOrigin } from "../messages.ts";

export type ToolActivity = Pick<ToolCall, "id" | "name" | "arguments">;

export interface DirectMessageIntegration {
  readonly name: string;
  setTyping(origin: MessageOrigin | undefined): void;
  notice(origin: MessageOrigin, call: ToolActivity, key: string): Promise<void>;
  reply(origin: MessageOrigin, message: Reply, key: string): Promise<void>;
}

export interface Platform extends DirectMessageIntegration {
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}
