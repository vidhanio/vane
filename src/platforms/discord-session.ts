import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  defineDoc,
  LiveDoc,
  type Conversation,
  type ConversationView,
  type Cursor,
  type EntryId,
  type LiveState,
} from "@earendil-works/pi-durable";
import { DiscordAPIError, type Message, type ThreadChannel } from "discord.js";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PlatformMessage } from "../platform.ts";
import { log } from "../log.ts";
import { renderToolLog, responseOptions } from "./discord-content.ts";

const context = BACKGROUND_CONTEXT;
type DeliveryState = { lastInput?: EntryId; message?: string };
const Delivery = defineDoc<DeliveryState>({
  kind: "vidhan-bot.discord-delivery",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

export class DiscordSession {
  private closed = false;
  private work = Promise.resolve();
  private typing: ReturnType<typeof setInterval> | undefined;
  private message: Message | undefined;
  private rendered: ConversationView | undefined;
  private lastRender = 0;

  private constructor(
    readonly conversation: Conversation,
    private readonly thread: ThreadChannel,
    private readonly view: AttachedReplicatedState<ConversationView>,
    private delivery: DeliveryState,
  ) {
    view.subscribe(async () => {
      if (this.closed) return;
      this.setTyping(
        Boolean((view.value.docs[LiveDoc.definition.kind] as LiveState | undefined)?.run),
      );
      if (this.rendered === view.value) return;
      this.work = this.refresh();
      await this.work;
    });
  }

  static async open(conversation: Conversation, thread: ThreadChannel): Promise<DiscordSession> {
    const delivery = await conversation.commit(async (tx) => {
      const state = await tx.doc(Delivery, conversation.id);
      return { ...state };
    }, context);
    const view = await conversation.viewState(context);
    return new DiscordSession(conversation, thread, view, delivery);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.view.dispose();
    this.setTyping(false);
    await this.work;
    await this.render(this.view.value);
  }

  private async refresh(): Promise<void> {
    while (!this.closed) {
      try {
        await delay(Math.max(0, 750 - (Date.now() - this.lastRender)));
        if (this.closed) return;
        const value = this.view.value;
        await this.render(value);
        this.rendered = value;
        this.lastRender = Date.now();
        return;
      } catch (error) {
        console.error("Discord session update failed", { threadId: this.thread.id, error });
        await delay(5000);
      }
    }
  }

  private setTyping(active: boolean): void {
    if (!active) {
      if (this.typing !== undefined) clearInterval(this.typing);
      this.typing = undefined;
    } else if (this.typing === undefined && !this.closed) {
      const ping = () => {
        void this.thread
          .sendTyping()
          .catch((error: unknown) =>
            console.error("Discord typing failed", { threadId: this.thread.id, error }),
          );
      };
      ping();
      this.typing = setInterval(ping, 8000);
    }
  }

  private async render(view: ConversationView): Promise<void> {
    const query = {
      ...(this.delivery.lastInput === undefined ? {} : { minEntryId: this.delivery.lastInput }),
      order: "ascending" as const,
    };
    let cursor: Cursor | undefined;
    do {
      const page = await this.conversation.entries(query, 100, cursor, context);
      for (const input of page.items) {
        if (!PlatformMessage.is(input) || input.id === this.delivery.lastInput) continue;
        const submission = await this.conversation.commit(
          (tx) => tx.submissionByRequest(this.conversation.id, `discord:${input.data.id}`),
          context,
        );
        if (!submission || submission.type !== "input")
          throw new Error(`Missing Discord submission for message ${input.data.id}`);
        if (submission.status === "placed" || submission.status === "queued") {
          const content = renderToolLog(view, input.id);
          if (content) await this.reply(input.id, content);
          return;
        }
        if (submission.status === "done") {
          const answer = await this.conversation.commit(
            (tx) => tx.entry(AssistantEntry, submission.answer),
            context,
          );
          if (!answer) throw new Error(`Missing answer for message ${input.data.id}`);
          const text = answer.model
            ?.flatMap((message) =>
              message.role === "assistant"
                ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
                : [],
            )
            .join("\n");
          await this.reply(input.id, text || "Completed with no text response.");
        } else if (submission.reason === "aborted") {
          const message = await this.currentMessage();
          if (message)
            await message.delete().catch((error: unknown) => {
              if (!(error instanceof DiscordAPIError) || error.code !== 10008) throw error;
            });
        } else {
          await this.reply(input.id, `Session ended without an answer: ${submission.reason}.`);
        }
        await this.checkpoint({ lastInput: input.id });
        this.message = undefined;
        log("discord.response_delivered", {
          threadId: this.thread.id,
          messageId: input.data.id,
          status: submission.status,
        });
      }
      cursor = page.next;
    } while (cursor);
  }

  private async currentMessage(): Promise<Message | undefined> {
    if (this.message || !this.delivery.message) return this.message;
    try {
      this.message = await this.thread.messages.fetch(this.delivery.message);
    } catch (error) {
      if (!(error instanceof DiscordAPIError) || error.code !== 10008) throw error;
      await this.clearMessage();
    }
    return this.message;
  }

  private async reply(input: EntryId, text: string): Promise<void> {
    if (this.thread.archived) await this.thread.setArchived(false);
    const message = await this.currentMessage();
    if (message) {
      try {
        if (message.content !== text || message.attachments.size > 0)
          this.message = await message.edit(responseOptions(text));
        return;
      } catch (error) {
        if (!(error instanceof DiscordAPIError) || error.code !== 10008) throw error;
        await this.clearMessage();
      }
    }
    const nonce = createHash("sha256")
      .update(`${this.conversation.id}:${input}`)
      .digest("hex")
      .slice(0, 24);
    this.message = await this.thread.send({ ...responseOptions(text), nonce, enforceNonce: true });
    await this.checkpoint({ ...this.delivery, message: this.message.id });
  }

  private async clearMessage(): Promise<void> {
    this.message = undefined;
    const { message: _message, ...state } = this.delivery;
    await this.checkpoint(state);
  }

  private async checkpoint(state: DeliveryState): Promise<void> {
    await this.conversation.commit(async (tx) => {
      const doc = await tx.doc(Delivery, this.conversation.id);
      if (state.lastInput === undefined) delete doc.lastInput;
      else doc.lastInput = state.lastInput;
      if (state.message === undefined) delete doc.message;
      else doc.message = state.message;
    }, context);
    this.delivery = state;
  }
}
