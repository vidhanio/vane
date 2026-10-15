import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  contentText,
  type ImageContent,
  type JsonObject,
  type TextContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  defineDoc,
  defineEntry,
  LiveDoc,
  SessionFailed,
  UsageDoc,
  type Agent,
  type Conversation,
  type ConversationId,
  type ConversationView,
  type Cursor,
  type EntryId,
  type LiveState,
  type Submission,
  type UsageState,
  type UserInput,
} from "@earendil-works/pi-durable";
import {
  AttachmentBuilder,
  ChannelType,
  Client,
  codeBlock,
  Colors,
  DiscordAPIError,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  Partials,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type Attachment as DiscordAttachment,
  type Channel,
  type ChatInputCommandInteraction,
  type Message,
  type DMChannel,
  type PartialDMChannel,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import type { Bot } from "../bot.ts";
import { log } from "../log.ts";

const context = BACKGROUND_CONTEXT;
const snowflake = z.string().regex(/^\d{17,20}$/);
const configSchema = z.strictObject({
  token: z.string().min(1),
  guild_id: snowflake,
  channel_id: snowflake,
  allowed_user_ids: z.array(snowflake).min(1),
});
type DiscordConfig = z.infer<typeof configSchema>;

type DiscordThread = ThreadChannel | DMChannel | PartialDMChannel;
const threadKey = (thread: DiscordThread) => (thread.type === ChannelType.DM ? "dm" : thread.id);

const commands = [
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop the response running in this conversation")
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show this conversation's activity, model and usage")
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),
  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Reset this conversation to a fresh context")
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),
];

export class Discord {
  readonly name = "discord";
  private readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
    allowedMentions: { parse: [], repliedUser: false },
  });
  private readonly config: DiscordConfig;
  private channel: TextChannel | undefined;
  private stopping = false;
  private restoring = Promise.resolve();
  private readonly running = new Set<Promise<void>>();
  private readonly conversations = new Map<string, Promise<DiscordConversation>>();
  private readonly bindings = new Map<string, ConversationId>();

  constructor(
    private readonly bot: Bot,
    config: unknown,
  ) {
    this.config = configSchema.parse(config);
  }

  async start(): Promise<void> {
    const ready = new Promise<void>((resolve) =>
      this.client.once(Events.ClientReady, () => resolve()),
    );
    this.client.on(Events.Error, (error) => console.error("Discord error", error));
    this.client.on(Events.MessageCreate, (message) => {
      if (this.stopping || !this.channel || !this.allowed(message)) return;
      this.track(this.restoring.then(() => this.handle(message)));
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (this.stopping || !this.channel || !interaction.isChatInputCommand()) return;
      this.track(this.restoring.then(() => this.handleCommand(interaction)));
    });
    await this.client.login(this.config.token);
    await ready;
    const guild = await this.client.guilds.fetch(this.config.guild_id);
    const application = this.client.application;
    if (!application) throw new Error("Discord application is unavailable");
    await Promise.all([
      guild.commands.set(commands.map((command) => command.toJSON())),
      application.commands.set(
        commands.map((command) => ({
          ...command.toJSON(),
          contexts: [InteractionContextType.BotDM],
        })),
      ),
    ]).catch((error: unknown) => {
      throw new Error(
        "Could not register application commands; the bot needs the applications.commands scope.",
        { cause: error },
      );
    });
    const channel = await this.client.channels.fetch(this.config.channel_id);
    if (channel?.type !== ChannelType.GuildText || channel.guildId !== this.config.guild_id)
      throw new Error("discord channel_id must be a text channel in discord guild_id");
    this.channel = channel;
    this.restoring = this.restore();
    await this.restoring;
    log("discord.connected", {
      guildId: guild.id,
      channelId: channel.id,
      userId: this.client.user?.id,
    });
  }

  async stop(): Promise<void> {
    log("discord.stopping", { activeMessages: this.running.size });
    this.stopping = true;
    await Promise.allSettled(this.running);
    const conversations = await Promise.all(this.conversations.values());
    await Promise.allSettled(conversations.map((item) => item.conversation.waitForIdle(context)));
    await Promise.allSettled(conversations.map((item) => item.close()));
    this.conversations.clear();
    this.bindings.clear();
    await this.client.destroy();
    log("discord.disconnected");
  }

  private async restore(): Promise<void> {
    let cursor: Cursor | undefined;
    do {
      const page = await this.bot.harness.commit(
        (tx) => tx.scanConversations({}, 100, cursor),
        context,
      );
      for (const record of page.items) {
        const connection = await this.bot.harness.snapshot(DiscordConnection, record.id, context);
        if (!connection?.threadId) continue;
        this.bindings.set(connection.dm ? "dm" : connection.threadId, record.id);
        try {
          const thread = this.configuredThread(
            await this.client.channels.fetch(connection.threadId),
          );
          if (!thread) continue;
          const conversation = await this.bot.harness.conversation(record.id, context);
          if (conversation) await this.attach(thread, conversation);
        } catch (error) {
          console.error("Could not restore Discord conversation", {
            conversationId: record.id,
            threadId: connection.threadId,
            error,
          });
        }
      }
      cursor = page.next;
    } while (cursor);
  }

  private track(work: Promise<void>): void {
    const tracked = work
      .catch((error: unknown) => console.error("Discord work failed", error))
      .finally(() => this.running.delete(tracked));
    this.running.add(tracked);
  }

  /** Connect a Discord thread to a native conversation, creating one only when omitted. */
  attach(thread: DiscordThread, conversation?: Conversation): Promise<DiscordConversation> {
    if (
      thread.type !== ChannelType.DM &&
      (thread.parentId !== this.config.channel_id || thread.guildId !== this.config.guild_id)
    )
      throw new Error("Thread is outside the configured Discord channel");
    const key = threadKey(thread);
    const existing = this.conversations.get(key);
    if (existing)
      return existing.then((attached) => {
        if (conversation && attached.conversation.id !== conversation.id)
          throw new Error("Discord thread is already connected to another conversation");
        return attached;
      });
    const bound = this.bindings.get(key);
    if (conversation && bound !== undefined && bound !== conversation.id)
      throw new Error("Discord thread is already connected to another conversation");
    const opening = (
      conversation
        ? Promise.resolve(conversation)
        : bound !== undefined
          ? this.bot.harness.conversation(bound, context)
          : this.bot.harness.createConversation(
              {
                ownership: { kind: "ownerless" },
                init: async (tx, id) => {
                  const connection = await tx.doc(DiscordConnection, id);
                  connection.threadId = thread.id;
                  connection.dm = thread.type === ChannelType.DM;
                },
              },
              context,
            )
    )
      .then(async (native) => {
        if (!native) throw new Error(`Missing conversation for Discord thread ${thread.id}`);
        const attached = await DiscordConversation.open(native, thread);
        this.bindings.set(key, native.id);
        return attached;
      })
      .catch((error: unknown) => {
        this.conversations.delete(key);
        throw error;
      });
    this.conversations.set(key, opening);
    return opening;
  }

  private allowed(message: Message): boolean {
    return (
      !message.author.bot &&
      this.config.allowed_user_ids.includes(message.author.id) &&
      ((message.guildId === this.config.guild_id && message.channelId === this.config.channel_id) ||
        this.configuredThread(message.channel) !== undefined)
    );
  }

  private configuredThread(channel: Channel | null): DiscordThread | undefined {
    if (channel?.type === ChannelType.DM) return channel;
    if (!channel?.isThread()) return undefined;
    return channel.parentId === this.config.channel_id && channel.guildId === this.config.guild_id
      ? channel
      : undefined;
  }

  private async handle(message: Message): Promise<void> {
    const content = message.content.trim();
    if (!content && message.attachments.size === 0) return;
    log("discord.message_received", {
      messageId: message.id,
      channelId: message.channelId,
      userId: message.author.id,
      textLength: content.length,
      attachments: message.attachments.size,
    });
    const thread = this.configuredThread(message.channel) ?? (await this.thread(message));
    try {
      await (await this.attach(thread)).submit(message);
    } catch (error) {
      console.error(`Discord thread ${thread.id} failed`, error);
      if (!this.stopping) await thread.send(responseOptions(errorText(error)));
    }
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    log("discord.command_received", {
      command: interaction.commandName,
      userId: interaction.user.id,
      channelId: interaction.channelId,
    });
    if (
      (interaction.guildId !== null && interaction.guildId !== this.config.guild_id) ||
      !this.config.allowed_user_ids.includes(interaction.user.id)
    ) {
      await interaction.reply({
        content: "vidhan-bot is not available to you.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const thread = this.configuredThread(interaction.channel);
      const attached =
        thread?.type === ChannelType.DM
          ? await this.attach(thread)
          : thread
            ? await this.conversations.get(threadKey(thread))
            : undefined;
      if (!attached) {
        await interaction.editReply("Use this command in a connected conversation thread.");
        return;
      }
      switch (interaction.commandName) {
        case "stop":
          await attached.conversation.abort(context);
          await interaction.deleteReply();
          return;
        case "reset":
          await attached.reset();
          await interaction.editReply("Conversation reset.");
          return;
        case "status":
          await interaction.editReply({ embeds: [await attached.status()] });
          return;
        default:
          await interaction.editReply("Unknown command.");
      }
    } catch (error) {
      console.error(`Command ${interaction.commandName} failed`, error);
      await interaction.editReply(errorText(error)).catch(() => undefined);
    }
  }

  private async thread(message: Message): Promise<ThreadChannel> {
    if (message.thread) return message.thread;
    const thread = await message.startThread({
      name:
        message.cleanContent.replace(/\s+/g, " ").slice(0, 100).toWellFormed() ||
        "New conversation",
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    });
    log("discord.thread_created", { threadId: thread.id, messageId: message.id });
    return thread;
  }
}

const DiscordMessage = defineEntry<string>("vidhan-bot.message.discord");
const DiscordDMMessage = defineEntry<{ messageId: string; channelId: string }>(
  "vidhan-bot.message.discord.dm",
);
const requestId = (id: string) => `${DiscordMessage.kind}:${id}`;
const DiscordConnection = defineDoc<{ threadId?: string; dm?: boolean }>({
  kind: "vidhan-bot.conversation.discord",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});
type DeliveryState = { lastHandledInput?: EntryId; pendingReplyId?: string };
const DiscordDelivery = defineDoc<DeliveryState>({
  kind: "vidhan-bot.delivery.discord",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

export class DiscordConversation {
  private closed = false;
  private closing: Promise<void> | undefined;
  private incoming = Promise.resolve();
  private work = Promise.resolve();
  private updatedAt = 0;
  private typing: ReturnType<typeof setInterval> | undefined;
  private typingThread: DiscordThread;
  private message: { input: EntryId; value: Message } | undefined;

  private constructor(
    readonly conversation: Conversation,
    private readonly thread: DiscordThread,
    private readonly view: AttachedReplicatedState<ConversationView>,
    private readonly delivery: DeliveryState,
  ) {
    this.typingThread = thread;
    view.subscribe(async () => {
      if (this.closed) return;
      this.setTyping(
        Boolean((view.value.docs[LiveDoc.definition.kind] as LiveState | undefined)?.run),
      );
      this.work = this.refresh();
      await this.work;
    });
  }

  static async open(
    conversation: Conversation,
    thread: DiscordThread,
  ): Promise<DiscordConversation> {
    const delivery = await conversation.commit(async (tx) => {
      const connection = await tx.doc(DiscordConnection, conversation.id);
      if (
        connection.threadId !== undefined &&
        (connection.dm ? thread.type !== ChannelType.DM : connection.threadId !== thread.id)
      )
        throw new Error("Conversation is already connected to another Discord thread");
      connection.threadId = thread.id;
      connection.dm = thread.type === ChannelType.DM;
      return { ...(await tx.doc(DiscordDelivery, conversation.id)) };
    }, context);
    return new DiscordConversation(
      conversation,
      thread,
      await conversation.viewState(context),
      delivery,
    );
  }

  /** Translate and admit messages in arrival order; pi queues the runs. */
  submit(message: Message): Promise<Submission> {
    const submission = this.incoming.then(async () => {
      if (this.closed) throw new Error("Discord conversation is closed");
      const result = await this.conversation.submit(
        {
          type: "input",
          content: await messageContent(message),
          requestId: requestId(message.id),
          entry:
            message.channel.type === ChannelType.DM
              ? {
                  kind: DiscordDMMessage.kind,
                  data: { messageId: message.id, channelId: message.channelId },
                }
              : { kind: DiscordMessage.kind, data: message.id },
        },
        context,
      );
      log("discord.message_submitted", {
        threadId: this.thread.id,
        messageId: message.id,
        submissionId: result.id,
      });
      return result;
    });
    this.incoming = submission.then(
      () => undefined,
      () => undefined,
    );
    return submission;
  }

  reset(): Promise<void> {
    const reset = this.incoming.then(() => this.conversation.reset(undefined, context));
    this.incoming = reset.catch(() => undefined);
    return reset;
  }

  async status(): Promise<EmbedBuilder> {
    return conversationEmbed(await this.conversation.agent(context), this.view.value);
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      await this.incoming;
      this.view.dispose();
      this.setTyping(false);
      await this.work;
      await this.render(this.view.value);
    })());
  }

  private async refresh(): Promise<void> {
    while (!this.closed) {
      try {
        await delay(Math.max(0, 750 - (Date.now() - this.updatedAt)));
        if (this.closed) return;
        await this.render(this.view.value);
        this.updatedAt = Date.now();
        return;
      } catch (error) {
        console.error("Discord conversation update failed", { threadId: this.thread.id, error });
        if (error instanceof SessionFailed) return;
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
        void this.typingThread
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
      ...(this.delivery.lastHandledInput === undefined
        ? {}
        : { minEntryId: this.delivery.lastHandledInput }),
      order: "ascending" as const,
    };
    let cursor: Cursor | undefined;
    do {
      const page = await this.conversation.entries(query, 100, cursor, context);
      for (const input of page.items) {
        if (
          (!DiscordMessage.is(input) && !DiscordDMMessage.is(input)) ||
          (this.delivery.lastHandledInput !== undefined &&
            input.id <= this.delivery.lastHandledInput)
        )
          continue;
        const messageId = DiscordDMMessage.is(input) ? input.data.messageId : input.data;
        const thread = DiscordDMMessage.is(input)
          ? await this.thread.client.channels.fetch(input.data.channelId)
          : this.thread;
        if (!thread || (thread.type !== ChannelType.DM && !thread.isThread()))
          throw new Error(`Missing Discord channel for input ${messageId}`);
        const result = await this.conversation.commit(
          (tx) => tx.submissionByRequest(this.conversation.id, requestId(messageId)),
          context,
        );
        if (!result || result.type !== "input")
          throw new Error(`Missing Discord input ${messageId}`);
        if (result.status === "placed" || result.status === "queued") {
          this.typingThread = thread;
          const text = renderToolLog(view, input.id);
          if (text) await this.reply(input.id, text, thread);
          return;
        }
        if (result.status === "done") {
          const answer = await this.conversation.commit(
            (tx) => tx.entry(AssistantEntry, result.answer),
            context,
          );
          if (!answer) throw new Error(`Missing answer for Discord input ${messageId}`);
          const text = answer.model
            ?.flatMap((message) =>
              message.role === "assistant" ? [contentText(message.content)] : [],
            )
            .join("\n");
          await this.reply(input.id, text || "Completed with no text response.", thread);
        } else if (result.reason === "aborted") {
          const message = await this.currentMessage(input.id, thread);
          if (message)
            await message.delete().catch((error: unknown) => {
              if (!(error instanceof DiscordAPIError) || error.code !== 10008) throw error;
            });
        } else {
          await this.reply(
            input.id,
            `Conversation ended without an answer: ${result.reason}.`,
            thread,
          );
        }
        await this.conversation.commit(async (tx) => {
          const delivery = await tx.doc(DiscordDelivery, this.conversation.id);
          delivery.lastHandledInput = input.id;
          delete delivery.pendingReplyId;
        }, context);
        this.delivery.lastHandledInput = input.id;
        delete this.delivery.pendingReplyId;
        this.message = undefined;
        log("discord.response_delivered", {
          conversationId: this.conversation.id,
          messageId,
          status: result.status,
        });
      }
      cursor = page.next;
    } while (cursor);
  }

  private async currentMessage(
    input: EntryId,
    thread: DiscordThread,
  ): Promise<Message | undefined> {
    if (this.message?.input === input) return this.message.value;
    this.message = undefined;
    const id = this.delivery.pendingReplyId;
    if (id === undefined) return undefined;
    try {
      this.message = { input, value: await thread.messages.fetch(id) };
    } catch (error) {
      if (!(error instanceof DiscordAPIError) || error.code !== 10008) throw error;
      await this.clearMessage();
    }
    return this.message?.value;
  }

  private async reply(input: EntryId, text: string, thread: DiscordThread): Promise<void> {
    if (thread.isThread() && thread.archived) await thread.setArchived(false);
    const message = await this.currentMessage(input, thread);
    if (message) {
      try {
        if (message.content !== text || message.attachments.size > 0)
          this.message = { input, value: await message.edit(responseOptions(text)) };
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
    const sent = await thread.send({ ...responseOptions(text), nonce, enforceNonce: true });
    this.message = { input, value: sent };
    await this.conversation.commit(async (tx) => {
      (await tx.doc(DiscordDelivery, this.conversation.id)).pendingReplyId = sent.id;
    }, context);
    this.delivery.pendingReplyId = sent.id;
  }

  private async clearMessage(): Promise<void> {
    this.message = undefined;
    await this.conversation.commit(async (tx) => {
      delete (await tx.doc(DiscordDelivery, this.conversation.id)).pendingReplyId;
    }, context);
    delete this.delivery.pendingReplyId;
  }
}

const messageLimit = 1900;
const imageLimit = 10 * 1024 * 1024;
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function responseOptions(text: string) {
  return text.length <= messageLimit
    ? { content: text, files: [], attachments: [] }
    : {
        content: "",
        files: [new AttachmentBuilder(Buffer.from(text), { name: "response.md" })],
        attachments: [],
      };
}

function codeText(text: string): string {
  return stripVTControlCharacters(text).replaceAll("`", "`\u200b");
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `ERROR:\n${codeBlock(codeText(message).toWellFormed())}`;
}

function detailText(name: string, args: JsonObject): string {
  if (name === "bash") return typeof args.command === "string" ? args.command : "";
  if (name === "read" || name === "write" || name === "edit")
    return typeof args.path === "string" ? args.path : "";
  if (name.startsWith("herdr_")) {
    const target = args.agent ?? args.name;
    return typeof target === "string" ? target : "";
  }
  return "";
}

function renderToolLog(view: ConversationView, input: EntryId): string {
  const calls: ToolCall[] = [];
  for (const entry of view.entries) {
    if (entry.id < input) continue;
    for (const message of entry.model ?? []) {
      if (message.role === "assistant")
        for (const block of message.content) if (block.type === "toolCall") calls.push(block);
    }
  }
  return calls
    .slice(-10)
    .map((call) => {
      const name = call.name.replaceAll("`", "").replace(/\s+/g, " ").slice(0, 140).toWellFormed();
      const args = detailText(call.name, call.arguments)
        .replaceAll("`", "")
        .replace(/\s+/g, " ")
        .trim();
      const limit = Math.max(
        0,
        Math.min(call.name === "bash" ? 50 : Infinity, 140 - name.length - 1),
      );
      const detail = (
        args.length > limit ? `${args.slice(0, Math.max(0, limit - 1)).trimEnd()}…` : args
      ).toWellFormed();
      return `-# **\`${name}\`**${detail ? ` \`${detail}\`` : ""}`;
    })
    .join("\n");
}

function conversationEmbed(agent: Agent, view: ConversationView): EmbedBuilder {
  const live = view.docs[LiveDoc.definition.kind] as LiveState | undefined;
  const usage = view.docs[UsageDoc.definition.kind] as UsageState | undefined;
  const running = live?.tools?.findLast((tool) => tool.status === "running");
  const activity = !live?.run
    ? "idle"
    : live.compactions?.length
      ? "compacting"
      : running
        ? `using ${running.name}`
        : live.generation
          ? "thinking"
          : "working";
  let tokens = 0;
  let cost = 0;
  for (const bucket of [usage?.models, usage?.tools])
    for (const entry of Object.values(bucket ?? {})) {
      tokens += entry.totalTokens;
      cost += entry.cost.total;
    }
  return new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("Conversation status")
    .addFields(
      { name: "Status", value: activity, inline: true },
      {
        name: "Model",
        value: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "Not configured",
        inline: true,
      },
      { name: "Thinking", value: agent.thinkingLevel, inline: true },
      {
        name: "Usage",
        value: `${tokens.toLocaleString("en-US")} tokens · $${cost.toFixed(4)}`,
        inline: true,
      },
      { name: "Directory", value: `\`${agent.cwd ?? "Not configured"}\``, inline: false },
    );
}

async function messageContent(message: Message): Promise<UserInput> {
  const content: (TextContent | ImageContent)[] = [{ type: "text", text: message.content.trim() }];
  let imageBytes = 0;
  let imageCount = 0;
  for (const item of message.attachments.values()) {
    content.push({ type: "text", text: `Attachment (untrusted URL): ${item.url}` });
    const includeImage = Boolean(
      item.contentType?.startsWith("image/") &&
      imageCount < 4 &&
      imageBytes + item.size <= 20 * 1024 * 1024,
    );
    if (includeImage) {
      imageCount += 1;
      imageBytes += item.size;
    }
    const image = await readImage(item, includeImage);
    if (image) content.push(image);
  }
  return content;
}

async function readImage(
  item: DiscordAttachment,
  images: boolean,
): Promise<ImageContent | undefined> {
  const mimeType = item.contentType?.split(";", 1)[0]?.toLowerCase();
  if (!images || !mimeType || !imageTypes.has(mimeType) || item.size > imageLimit) return undefined;
  const url = new URL(item.url);
  if (
    url.protocol !== "https:" ||
    !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
  )
    return undefined;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok || !response.body)
      throw new Error(`Image download failed: HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > Math.min(imageLimit, item.size))
          throw new Error("Image attachment exceeds its size limit");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    log("discord.image_loaded", { attachmentId: item.id, bytes: size, mimeType });
    return { type: "image", data: Buffer.concat(chunks).toString("base64"), mimeType };
  } catch (error) {
    console.error("Discord image download failed", { attachmentId: item.id, error });
    return undefined;
  }
}
