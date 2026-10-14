import type { ImageContent } from "@earendil-works/pi-ai";
import { defineEntry, type Conversation, type Submission } from "@earendil-works/pi-durable";

export const PlatformMessage = defineEntry<{ id: string; author: string }>("vidhan-bot.message");

/** A file attached to an incoming message. */
export interface Attachment {
  readonly url: string;
  readonly image?: ImageContent;
}

/** A message received by a platform-scoped host. */
export interface IncomingMessage {
  /** The platform's session id. */
  readonly session: string;
  /** The platform's message id. Retries reuse it. */
  readonly id: string;
  readonly author: string;
  readonly text: string;
  readonly attachments?: readonly Attachment[];
}

/** Platform routing over pi's native conversations and submissions. */
export interface PlatformHost {
  /** List existing session ids for startup recovery. */
  sessions(): Promise<string[]>;
  /** Find an existing conversation without creating one. */
  find(id: string): Promise<Conversation | undefined>;
  /** Find or create a conversation. */
  conversation(id: string): Promise<Conversation>;
  /** Durably admit a message; pi owns queuing and execution. */
  submit(message: IncomingMessage): Promise<Submission>;
}

/** A platform integration. */
export interface Platform {
  readonly name: string;
  start(host: PlatformHost): Promise<void>;
  /** Stop receiving and release resources, letting in-flight runs finish. */
  stop(): Promise<void>;
}

/** Builds a platform from its [platforms.<name>] config table. */
export interface PlatformDefinition {
  readonly name: string;
  create(raw: unknown): Platform;
}
