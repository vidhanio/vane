import { copyJson, type AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  defineDoc,
  defineEntry,
  defineExtension,
  wrapTool,
  SessionFailed,
  type Conversation,
  type ConversationView,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type UserInput,
  type ToolRegistration,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { setTimeout as delay } from "node:timers/promises";
import { prepareReply } from "./attachments.ts";
import {
  AgentNotification,
  DirectMessage,
  messageRequestId,
  resolveMessageOrigin,
  type MessageOrigin,
} from "./messages.ts";
import type { DirectMessageIntegration, ToolActivity } from "./platforms/index.ts";
import { MissingReplyManifest, readReply, replyTool } from "./reply.ts";

const context = BACKGROUND_CONTEXT;
const ToolAdmission = defineEntry<{ id: string; name: string; arguments: JsonObject }>(
  "vane.tool.admission",
);

export function toolNotices(tools: readonly ToolRegistration[]) {
  return defineExtension({
    name: "vane.tool.notices",
    wraps: tools
      .filter((tool) => tool.name !== replyTool.name)
      .map((tool) =>
        wrapTool(tool, (original) => ({
          ...original,
          execute: async (args, api, callContext) => {
            await api.commit(async (tx) => {
              let cursor;
              do {
                const page = await tx.scanEntries(
                  { conversationId: api.conversationId },
                  100,
                  cursor,
                );
                if (
                  page.items.some(
                    (entry) => ToolAdmission.is(entry) && entry.data.id === api.callId,
                  )
                )
                  return;
                if (
                  page.items.some(
                    (entry) =>
                      AssistantEntry.is(entry) &&
                      entry.model?.some(
                        (message) =>
                          message.role === "assistant" &&
                          message.content.some(
                            (block) => block.type === "toolCall" && block.id === api.callId,
                          ),
                      ),
                  )
                )
                  break;
                cursor = page.next;
              } while (cursor);
              await tx.appendEntry(ToolAdmission, api.conversationId, {
                data: {
                  id: api.callId,
                  name: original.name,
                  arguments: copyJson(args) as JsonObject,
                },
              });
            }, callContext);
            return original.execute(args, api, callContext);
          },
        })),
      ),
  });
}

type DeliveryState = {
  lastHandledInput?: EntryId;
  announcement?: { input: EntryId; count: number };
  lastFailure?: {
    input: EntryId;
    answer: EntryId;
    reason: "missing_reply_manifest";
    destinations: string[];
  };
  lastAnswer?: { answer: EntryId; destinations: string[] };
};
const Delivery = defineDoc<DeliveryState>({
  kind: "vane.delivery",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

const SessionSettings = defineDoc<{ showTools: boolean }>({
  kind: "vane.session.settings",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ showTools: true }),
});

export class Session {
  private readonly integrations = new Map<string, DirectMessageIntegration>();
  private readonly tools = new Map<EntryId, Map<string, ToolActivity | null | undefined>>();
  private incoming = Promise.resolve();
  private work = Promise.resolve();
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
      async (tx) => copyJson(await tx.doc(Delivery, conversation.id)) as DeliveryState,
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
          whenBusy: "steer",
          requestId: messageRequestId(origin),
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

  toggleTools(): Promise<boolean> {
    return this.enqueue(() =>
      this.conversation.commit(async (tx) => {
        const settings = await tx.doc(SessionSettings, this.conversation.id);
        settings.showTools = !settings.showTools;
        return settings.showTools;
      }, context),
    );
  }

  close(): Promise<void> {
    return (this.closing ??= this.finish());
  }

  private async finish(): Promise<void> {
    this.setTyping(undefined);
    this.shutdown.abort();
    this.view.dispose();
    this.cancelPreparation();
    await Promise.all([this.incoming, this.work]);
  }

  private cancelPreparation(): void {
    this.preparation.abort();
    this.preparation = new AbortController();
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Session is closing"));
    const work = this.incoming.then(action);
    this.incoming = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  private captureTools(): void {
    const view = this.view.value;
    this.tools.clear();
    const resolved = new Set(
      view.entries.flatMap((entry) =>
        (entry.model ?? []).flatMap((message) =>
          message.role === "toolResult" ? [message.toolCallId] : [],
        ),
      ),
    );
    const admitted = new Map(
      view.entries.flatMap((entry) =>
        ToolAdmission.is(entry) ? [[entry.data.id, entry.data] as const] : [],
      ),
    );
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
        if (message.role === "assistant" && message.stopReason === "toolUse")
          for (const block of message.content)
            if (block.type === "toolCall" && block.name !== replyTool.name) {
              const admission = admitted.get(block.id);
              calls.set(block.id, admission ?? (resolved.has(block.id) ? null : undefined));
            }
      }
    }
  }

  private refresh(): void {
    if (this.shutdown.signal.aborted) return;
    this.dirty = true;
    if (this.refreshing) return;
    this.refreshing = true;
    this.work = (async () => {
      while (this.dirty && !this.shutdown.signal.aborted) {
        this.dirty = false;
        try {
          await delay(Math.max(0, 750 - (Date.now() - this.updatedAt)), undefined, {
            signal: this.shutdown.signal,
          });
          await this.deliver();
          this.updatedAt = Date.now();
        } catch (error) {
          if (this.shutdown.signal.aborted) return;
          console.error("Session delivery failed", error);
          if (error instanceof SessionFailed) {
            this.setTyping(undefined);
            return;
          }
          this.dirty = true;
          await delay(5000, undefined, { signal: this.shutdown.signal }).catch(() => undefined);
        }
      }
    })().finally(() => {
      this.refreshing = false;
    });
  }

  private setTyping(origin: MessageOrigin | undefined): void {
    if (this.closing) origin = undefined;
    for (const integration of this.integrations.values())
      integration.setTyping(integration.name === origin?.platform ? origin : undefined);
  }

  private async deliver(): Promise<void> {
    if (this.shutdown.signal.aborted) return;
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
        if (this.shutdown.signal.aborted) return;
        if (
          (!DirectMessage.is(input) && !AgentNotification.is(input)) ||
          (this.delivery.lastHandledInput !== undefined &&
            input.id <= this.delivery.lastHandledInput)
        )
          continue;
        if (!(await this.deliverInput(input))) return;
      }
      cursor = page.next;
    } while (cursor);
    this.setTyping(undefined);
  }

  private async deliverInput(input: EntryRecord): Promise<boolean> {
    const origin = await this.conversation.commit((tx) => resolveMessageOrigin(tx, input), context);
    const integration = this.integrations.get(origin.platform);
    if (!integration) {
      this.setTyping(undefined);
      return false;
    }
    const result = await this.conversation.commit(
      (tx) =>
        tx.submissionByRequest(
          this.conversation.id,
          AgentNotification.is(input) ? input.data.requestId : messageRequestId(origin),
        ),
      context,
    );
    if (this.shutdown.signal.aborted) return false;
    if (!result || result.type !== "input")
      throw new Error(`Missing submission for input ${input.id}`);
    const key = `${this.conversation.id}:${input.id}`;
    await this.announceTools(integration, origin, input.id, `${key}:tools`);
    if (result.status === "placed" || result.status === "queued") {
      this.setTyping(origin);
      return false;
    }
    this.setTyping(result.status === "done" || result.reason !== "aborted" ? origin : undefined);
    const destination = `${origin.platform}:${origin.channelId}`;
    const previousAnswer = this.delivery.lastAnswer;
    const alreadyDelivered =
      result.status === "done" &&
      previousAnswer?.answer === result.answer &&
      previousAnswer.destinations.includes(destination);
    let lastAnswer =
      result.status === "done"
        ? {
            answer: result.answer,
            destinations: [
              ...new Set([
                ...(previousAnswer?.answer === result.answer ? previousAnswer.destinations : []),
                destination,
              ]),
            ],
          }
        : previousAnswer;
    if (result.status === "done" && !alreadyDelivered) {
      try {
        const request = await this.conversation.commit(async (tx) => {
          const answer = await tx.entry(AssistantEntry, result.answer);
          if (!answer) throw new Error(`Missing answer for input ${input.id}`);
          return readReply(tx, answer);
        }, context);
        const reply = await prepareReply(request, this.shutdown.signal);
        await integration.reply(origin, reply, `${key}:answer`);
      } catch (error) {
        if (!(error instanceof MissingReplyManifest)) throw error;
        this.setTyping(undefined);
        const previousFailure = this.delivery.lastFailure;
        const failedDestinations =
          previousFailure?.answer === result.answer ? previousFailure.destinations : [];
        const alreadyFailed = failedDestinations.includes(destination);
        const failure = {
          input: input.id,
          answer: result.answer,
          reason: "missing_reply_manifest" as const,
          destinations: [...new Set([...failedDestinations, destination])],
        };
        await this.conversation.commit(async (tx) => {
          const delivery = await tx.doc(Delivery, this.conversation.id);
          delivery.lastFailure = failure;
          delivery.lastHandledInput = input.id;
        }, context);
        this.delivery.lastFailure = failure;
        this.delivery.lastHandledInput = input.id;
        lastAnswer = previousAnswer;
        if (!alreadyFailed) {
          try {
            await integration.reply(
              origin,
              { text: "Answer delivery failed: no saved reply manifest." },
              `${this.conversation.id}:${result.answer}:${destination}:delivery-error`,
            );
          } catch (deliveryError) {
            console.error("Failed to send terminal delivery error", deliveryError);
          }
        }
      }
    } else if (result.status !== "done" && result.reason !== "aborted") {
      await integration.reply(
        origin,
        { text: `Session ended without an answer: ${result.reason}.` },
        `${key}:answer`,
      );
    }
    this.setTyping(undefined);
    await this.conversation.commit(async (tx) => {
      const delivery = await tx.doc(Delivery, this.conversation.id);
      delivery.lastHandledInput = input.id;
      if (lastAnswer) delivery.lastAnswer = lastAnswer;
      delete delivery.announcement;
    }, context);
    this.delivery.lastHandledInput = input.id;
    if (lastAnswer) this.delivery.lastAnswer = lastAnswer;
    delete this.delivery.announcement;
    this.tools.delete(input.id);
    return true;
  }

  private async announceTools(
    integration: DirectMessageIntegration,
    origin: MessageOrigin,
    input: EntryId,
    key: string,
  ): Promise<void> {
    const calls = [...(this.tools.get(input)?.values() ?? [])];
    const count =
      this.delivery.announcement?.input === input ? this.delivery.announcement.count : 0;
    if (calls.length <= count) return;
    const showTools = await this.conversation.commit(
      async (tx) => (await tx.doc(SessionSettings, this.conversation.id)).showTools,
      context,
    );
    for (const [index, call] of calls.entries()) {
      if (index < count) continue;
      if (call === undefined) break;
      if (showTools && call !== null) {
        try {
          await integration.notice(
            origin,
            call,
            `${key}:${origin.platform}:${origin.channelId}:${call.id}`,
          );
        } catch (error) {
          console.error("Tool notice failed", error);
        }
      }
      const announcement = { input, count: index + 1 };
      await this.conversation.commit(async (tx) => {
        (await tx.doc(Delivery, this.conversation.id)).announcement = announcement;
      }, context);
      this.delivery.announcement = announcement;
    }
  }
}
