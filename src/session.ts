import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText, type ToolCall } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  defineDoc,
  defineEntry,
  LiveDoc,
  SessionFailed,
  type Conversation,
  type ConversationView,
  type Cursor,
  type EntryId,
  type LiveState,
  type UserInput,
} from "@earendil-works/pi-durable";
import { setTimeout as delay } from "node:timers/promises";
import { AgentNotification } from "./notifications.ts";

const context = BACKGROUND_CONTEXT;

export type MessageOrigin = { platform: string; channelId: string; messageId: string };
export type ToolActivity = Pick<ToolCall, "id" | "name" | "arguments"> & { details?: unknown };

export interface DirectMessageIntegration {
  readonly name: string;
  progress(
    origin: MessageOrigin,
    calls: ToolActivity[],
    id: string | undefined,
    key: string,
  ): Promise<string>;
  removeProgress(origin: MessageOrigin, id: string): Promise<void>;
  reply(origin: MessageOrigin, text: string, key: string): Promise<void>;
}

const DirectMessage = defineEntry<MessageOrigin>("vane.message");
const requestId = (origin: MessageOrigin) =>
  `${origin.platform}:${origin.channelId}:${origin.messageId}`;
type DeliveryState = { lastHandledInput?: EntryId; progressId?: string };
const Delivery = defineDoc<DeliveryState>({
  kind: "vane.delivery",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

export class Session {
  private readonly integrations = new Map<string, DirectMessageIntegration>();
  private readonly tools = new Map<EntryId, Map<string, ToolActivity>>();
  private incoming = Promise.resolve();
  private work = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;
  private dirty = false;
  private refreshing = false;
  private updatedAt = 0;
  private readonly shutdown = new AbortController();
  private preparation = new AbortController();

  private constructor(
    readonly conversation: Conversation,
    readonly view: AttachedReplicatedState<ConversationView>,
    private readonly delivery: DeliveryState,
  ) {
    view.subscribe(() => {
      this.captureTools();
      this.refresh();
    });
    this.captureTools();
  }

  static async open(conversation: Conversation): Promise<Session> {
    const delivery = await conversation.commit(
      async (tx) => ({ ...(await tx.doc(Delivery, conversation.id)) }),
      context,
    );
    return new Session(conversation, await conversation.viewState(context), delivery);
  }

  connect(integration: DirectMessageIntegration): void {
    if (this.integrations.has(integration.name))
      throw new Error(`Integration already connected: ${integration.name}`);
    this.integrations.set(integration.name, integration);
    this.refresh();
  }

  submit(
    origin: MessageOrigin,
    content: (signal: AbortSignal) => Promise<UserInput>,
  ): Promise<void> {
    const { signal } = this.preparation;
    return this.enqueue(async () => {
      if (signal.aborted) return;
      let input: UserInput;
      try {
        input = await content(signal);
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      if (signal.aborted) return;
      await this.conversation.submit(
        {
          type: "input",
          content: input,
          requestId: requestId(origin),
          entry: { kind: DirectMessage.kind, data: origin },
        },
        context,
      );
    });
  }

  stop(): Promise<void> {
    this.cancelPreparation();
    return this.enqueue(() => this.conversation.abort(context));
  }

  reset(): Promise<void> {
    this.cancelPreparation();
    return this.enqueue(async () => {
      await this.conversation.abort(context, { background: true });
      await this.conversation.reset(undefined, context);
    });
  }

  close(): Promise<void> {
    return (this.closing ??= this.finish());
  }

  private async finish(): Promise<void> {
    this.cancelPreparation();
    await this.incoming;
    await this.conversation.abort(context, { background: true });
    this.closed = true;
    this.shutdown.abort();
    this.view.dispose();
    await this.work;
    await this.deliver();
  }

  private cancelPreparation(): void {
    this.preparation.abort();
    this.preparation = new AbortController();
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    if (this.closing) return Promise.reject(new Error("Session is closing"));
    const work = this.incoming.then(() => {
      if (this.closed) throw new Error("Session is closed");
      return action();
    });
    this.incoming = work.catch(() => undefined);
    return work;
  }

  private captureTools(): void {
    const view = this.view.value;
    const live = view.docs[LiveDoc.definition.kind] as LiveState | undefined;
    let input: EntryId | undefined;
    for (const entry of view.entries) {
      if (DirectMessage.is(entry) || AgentNotification.is(entry)) input = entry.id;
      if (
        input === undefined ||
        (this.delivery.lastHandledInput !== undefined && input <= this.delivery.lastHandledInput)
      )
        continue;
      let calls = this.tools.get(input);
      if (!calls) {
        calls = new Map();
        this.tools.set(input, calls);
      }
      for (const message of entry.model ?? []) {
        if (message.role === "assistant")
          for (const block of message.content)
            if (block.type === "toolCall")
              calls.set(block.id, { ...calls.get(block.id), ...block });
        if (message.role === "toolResult") {
          const call = calls.get(message.toolCallId);
          if (call) call.details = message.details;
        }
      }
    }
    const owners = new Map<string, Map<string, ToolActivity>>();
    for (const calls of this.tools.values()) for (const id of calls.keys()) owners.set(id, calls);
    for (const slot of live?.tools ?? []) {
      const call = owners.get(slot.callId)?.get(slot.callId);
      if (call && slot.details !== undefined) call.details = slot.details;
    }
    for (const nested of live?.nestedTools ?? []) {
      const calls = owners.get(nested.parentCallId);
      if (!calls) continue;
      calls.set(nested.callId, {
        id: nested.callId,
        name: nested.name,
        arguments: nested.arguments,
        details: nested.details ?? calls.get(nested.callId)?.details,
      });
      owners.set(nested.callId, calls);
    }
  }

  private refresh(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.refreshing) return;
    this.refreshing = true;
    this.work = (async () => {
      while (this.dirty && !this.closed) {
        this.dirty = false;
        try {
          await delay(Math.max(0, 750 - (Date.now() - this.updatedAt)), undefined, {
            signal: this.shutdown.signal,
          });
          await this.deliver();
          this.updatedAt = Date.now();
        } catch (error) {
          if (this.closed) return;
          console.error("Session delivery failed", error);
          if (error instanceof SessionFailed) return;
          this.dirty = true;
          await delay(5000, undefined, { signal: this.shutdown.signal }).catch(() => undefined);
        }
      }
    })().finally(() => {
      this.refreshing = false;
    });
  }

  private async deliver(): Promise<void> {
    let cursor: Cursor | undefined;
    do {
      const page = await this.conversation.entries(
        {
          ...(this.delivery.lastHandledInput === undefined
            ? {}
            : { minEntryId: this.delivery.lastHandledInput }),
          order: "ascending",
        },
        100,
        cursor,
        context,
      );
      for (const input of page.items) {
        if (
          (!DirectMessage.is(input) && !AgentNotification.is(input)) ||
          (this.delivery.lastHandledInput !== undefined &&
            input.id <= this.delivery.lastHandledInput)
        )
          continue;
        const originId = AgentNotification.is(input) ? input.data.origin : undefined;
        const source =
          originId === undefined
            ? input
            : await this.conversation.commit((tx) => tx.entry(originId), context);
        if (!source || !DirectMessage.is(source))
          throw new Error(`Missing message origin for input ${input.id}`);
        const origin = source.data;
        const integration = this.integrations.get(origin.platform);
        if (!integration) return;
        const result = await this.conversation.commit(
          (tx) =>
            tx.submissionByRequest(
              this.conversation.id,
              AgentNotification.is(input) ? input.data.requestId : requestId(origin),
            ),
          context,
        );
        if (!result || result.type !== "input")
          throw new Error(`Missing submission for input ${input.id}`);
        const key = `${this.conversation.id}:${input.id}`;
        if (result.status === "placed" || result.status === "queued") {
          const calls = [...(this.tools.get(input.id)?.values() ?? [])];
          if (calls.length) {
            const id = await integration.progress(
              origin,
              calls,
              this.delivery.progressId,
              `${key}:tools`,
            );
            if (id !== this.delivery.progressId) {
              await this.conversation.commit(async (tx) => {
                (await tx.doc(Delivery, this.conversation.id)).progressId = id;
              }, context);
              this.delivery.progressId = id;
            }
          }
          return;
        }
        if (this.delivery.progressId) {
          await integration.removeProgress(origin, this.delivery.progressId);
          await this.conversation.commit(async (tx) => {
            delete (await tx.doc(Delivery, this.conversation.id)).progressId;
          }, context);
          delete this.delivery.progressId;
        }
        if (result.status === "done") {
          const answer = await this.conversation.commit(
            (tx) => tx.entry(AssistantEntry, result.answer),
            context,
          );
          if (!answer) throw new Error(`Missing answer for input ${input.id}`);
          const text = answer.model
            ?.flatMap((message) =>
              message.role === "assistant" ? [contentText(message.content)] : [],
            )
            .join("\n");
          await integration.reply(
            origin,
            text || "Completed with no text response.",
            `${key}:answer`,
          );
        } else if (result.reason !== "aborted") {
          await integration.reply(
            origin,
            `Session ended without an answer: ${result.reason}.`,
            `${key}:answer`,
          );
        }
        await this.conversation.commit(async (tx) => {
          (await tx.doc(Delivery, this.conversation.id)).lastHandledInput = input.id;
        }, context);
        this.delivery.lastHandledInput = input.id;
        this.tools.delete(input.id);
      }
      cursor = page.next;
    } while (cursor);
  }
}
