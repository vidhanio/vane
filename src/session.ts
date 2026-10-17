import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  defineDoc,
  LiveDoc,
  SessionFailed,
  type Conversation,
  type ConversationView,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type LiveState,
  type UserInput,
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
import { readReply, replyTool } from "./reply.ts";

const context = BACKGROUND_CONTEXT;

type DeliveryState = { lastHandledInput?: EntryId; progressIds?: string[] };
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
  private readonly tools = new Map<EntryId, Map<string, ToolActivity>>();
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
          whenBusy: "followUp",
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

  reset(): Promise<void> {
    this.cancelPreparation();
    return this.enqueue(async () => {
      await this.conversation.abort(context, { background: true });
      await this.conversation.reset(undefined, context);
    });
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
            if (block.type === "toolCall" && block.name !== replyTool.name)
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
    if (result.status === "placed" || result.status === "queued") {
      this.setTyping(origin);
      await this.updateProgress(integration, origin, input.id, `${key}:tools`);
      return false;
    }
    this.setTyping(result.status === "done" || result.reason !== "aborted" ? origin : undefined);
    if (this.delivery.progressIds) {
      const showTools = await this.conversation.commit(
        async (tx) => (await tx.doc(SessionSettings, this.conversation.id)).showTools,
        context,
      );
      if (!showTools) await integration.removeProgress(origin, this.delivery.progressIds);
    }
    if (result.status === "done") {
      const request = await this.conversation.commit(async (tx) => {
        const answer = await tx.entry(AssistantEntry, result.answer);
        if (!answer) throw new Error(`Missing answer for input ${input.id}`);
        return readReply(tx, answer);
      }, context);
      const reply = await prepareReply(request, this.shutdown.signal);
      await integration.reply(origin, reply, `${key}:answer`);
    } else if (result.reason !== "aborted") {
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
      delete delivery.progressIds;
    }, context);
    this.delivery.lastHandledInput = input.id;
    delete this.delivery.progressIds;
    this.tools.delete(input.id);
    return true;
  }

  private async updateProgress(
    integration: DirectMessageIntegration,
    origin: MessageOrigin,
    input: EntryId,
    key: string,
  ): Promise<void> {
    const calls = [...(this.tools.get(input)?.values() ?? [])];
    if (!calls.length) return;
    const previous = this.delivery.progressIds ?? [];
    const ids = await integration.progress(origin, calls, previous, key);
    if (ids.length === previous.length && ids.every((id, index) => id === previous[index])) return;
    await this.conversation.commit(async (tx) => {
      (await tx.doc(Delivery, this.conversation.id)).progressIds = ids;
    }, context);
    this.delivery.progressIds = ids;
  }
}
