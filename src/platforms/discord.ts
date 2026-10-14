import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  ImageContent,
  JsonObject,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  defineDoc,
  defineEntry,
  LiveDoc,
  UsageDoc,
  type Agent,
  type Conversation,
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
  escapeMarkdown,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type Attachment as DiscordAttachment,
  type Channel,
  type ChatInputCommandInteraction,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import type { Bot } from "../bot.ts";
import { herdrProgressSchema } from "../herdr.ts";
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

const commands = [
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop the response running in this session")
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show this session's activity, model and usage")
    .setContexts(InteractionContextType.Guild),
];

export class Discord {
  readonly name = "discord";
  private readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    allowedMentions: { parse: [], repliedUser: false },
  });
  private readonly config: DiscordConfig;
  private channel: TextChannel | undefined;
  private stopping = false;
  private readonly running = new Set<Promise<void>>();
  private readonly sessions = new Map<string, Promise<DiscordSession>>();

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
      this.track(this.handle(message));
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (this.stopping || !this.channel || !interaction.isChatInputCommand()) return;
      this.track(this.handleCommand(interaction));
    });
    await this.client.login(this.config.token);
    await ready;
    const guild = await this.client.guilds.fetch(this.config.guild_id);
    await guild.commands
      .set(commands.map((command) => command.toJSON()))
      .catch((error: unknown) => {
        throw new Error(
          "Could not register application commands; the bot needs the applications.commands scope.",
          { cause: error },
        );
      });
    const channel = await this.client.channels.fetch(this.config.channel_id);
    if (channel?.type !== ChannelType.GuildText || channel.guildId !== this.config.guild_id)
      throw new Error("discord channel_id must be a text channel in discord guild_id");
    this.channel = channel;
    for (const [id, conversationId] of Object.entries(await this.bot.conversations(this.name))) {
      try {
        const thread = this.sessionThread(await this.client.channels.fetch(id));
        if (!thread) continue;
        const conversation = await this.bot.harness.conversation(conversationId, context);
        if (conversation) await this.attach(thread, conversation);
      } catch (error) {
        console.error("Could not restore Discord session", { sessionId: id, error });
      }
    }
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
    const sessions = await Promise.all(this.sessions.values());
    await Promise.allSettled(sessions.map((session) => session.conversation.waitForIdle(context)));
    await Promise.allSettled(sessions.map((session) => session.close()));
    this.sessions.clear();
    await this.client.destroy();
    log("discord.disconnected");
  }

  private track(work: Promise<void>): void {
    const tracked = work
      .catch((error: unknown) => console.error("Discord work failed", error))
      .finally(() => this.running.delete(tracked));
    this.running.add(tracked);
  }

  private attach(thread: ThreadChannel, conversation: Conversation): Promise<DiscordSession> {
    const existing = this.sessions.get(thread.id);
    if (existing) return existing;
    const session = DiscordSession.open(conversation, thread).catch((error: unknown) => {
      this.sessions.delete(thread.id);
      throw error;
    });
    this.sessions.set(thread.id, session);
    return session;
  }

  private allowed(message: Message): boolean {
    return (
      !message.author.bot &&
      message.guildId === this.config.guild_id &&
      this.config.allowed_user_ids.includes(message.author.id) &&
      (message.channelId === this.config.channel_id ||
        this.sessionThread(message.channel) !== undefined)
    );
  }

  private sessionThread(channel: Channel | null): ThreadChannel | undefined {
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
    const thread = message.channel.isThread() ? message.channel : await this.thread(message);
    try {
      const conversation = await this.bot.conversation(this.name, thread.id);
      const session = await this.attach(thread, conversation);
      await session.submit(message);
    } catch (error) {
      console.error(`Session ${thread.id} failed`, error);
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
      interaction.guildId !== this.config.guild_id ||
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
      const thread = this.sessionThread(interaction.channel);
      const conversation = thread
        ? await this.bot.findConversation(this.name, thread.id)
        : undefined;
      if (!thread || !conversation) {
        await interaction.editReply("Use this command in a managed session thread.");
        return;
      }
      const session = await this.attach(thread, conversation);
      switch (interaction.commandName) {
        case "stop":
          await session.conversation.abort(context);
          await interaction.deleteReply();
          return;
        case "status":
          await interaction.editReply({ embeds: [await session.status()] });
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
      name: message.cleanContent.replace(/\s+/g, " ").slice(0, 100).toWellFormed() || "New session",
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    });
    log("discord.thread_created", { threadId: thread.id, messageId: message.id });
    return thread;
  }
}

const DiscordMessage = defineEntry<{ id: string; author: string }>("vidhan-bot.message");
const requestId = (id: string) => `discord:${id}`;
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
  private incoming = Promise.resolve();
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

  /** Translate and admit messages in arrival order; pi queues the runs. */
  submit(message: Message): Promise<Submission> {
    const submission = this.incoming.then(async () => {
      if (this.closed) throw new Error("Discord session is closed");
      const result = await this.conversation.submit(
        {
          type: "input",
          content: await messageContent(message),
          requestId: requestId(message.id),
          entry: {
            kind: DiscordMessage.kind,
            data: { id: message.id, author: message.author.username },
          },
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

  async status(): Promise<EmbedBuilder> {
    return sessionEmbed(await this.conversation.agent(context), this.view.value);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.incoming;
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
        if (!DiscordMessage.is(input) || input.id === this.delivery.lastInput) continue;
        const submission = await this.conversation.commit(
          (tx) => tx.submissionByRequest(this.conversation.id, requestId(input.data.id)),
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
  if (name === "bash")
    return String(args.command ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 50);
  if (name === "read" || name === "write" || name === "edit") return String(args.path ?? "");
  if (name === "herdr") return [args.action, args.agent ?? args.name].filter(Boolean).join(" ");
  return "";
}

function toolOutput(name: string, output: string, details: unknown): string {
  if (name === "bash") return output;
  if (name !== "herdr") return "";
  const parsed = herdrProgressSchema.safeParse(details);
  if (!parsed.success) return output;
  const { agents, report, truncated, note } = parsed.data;
  const rows = agents.map((agent) =>
    [
      agent.name,
      agent.pane_id,
      agent.agent_status,
      agent.agent,
      agent.title ?? agent.terminal_title_stripped,
      agent.cwd,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  if (report) rows.push(report.split("\n").slice(-6).join("\n"));
  if (truncated) rows.push("… output truncated");
  if (note) rows.push(note);
  return rows.join("\n");
}

function renderToolLog(view: ConversationView, input: EntryId): string {
  const calls: ToolCall[] = [];
  const results = new Map<string, ToolResultMessage>();
  for (const entry of view.entries) {
    if (entry.id < input) continue;
    for (const message of entry.model ?? []) {
      if (message.role === "toolResult") results.set(message.toolCallId, message);
      if (message.role === "assistant")
        for (const block of message.content) if (block.type === "toolCall") calls.push(block);
    }
  }
  const live = view.docs[LiveDoc.definition.kind] as LiveState | undefined;
  const recent = calls.slice(-5);
  const headers = recent.map((call) => {
    const detail = detailText(call.name, call.arguments);
    const label = `${call.name}${detail ? ` — ${detail}` : ""}`.replace(/\s+/g, " ");
    return `*${escapeMarkdown(label.slice(0, 140).toWellFormed())}*`;
  });
  const outputs = recent.map((call) => {
    const slot = live?.tools?.find((tool) => tool.callId === call.id);
    const result = results.get(call.id);
    const output =
      slot?.output ??
      result?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n") ??
      "";
    return codeText(toolOutput(call.name, output, slot?.details ?? result?.details));
  });
  const active = outputs.filter(Boolean).length;
  const budget = Math.max(0, messageLimit - headers.join("\n").length - active * 10);
  const perCall = active ? Math.min(600, Math.floor(budget / active)) : 0;
  return headers
    .map((header, index) => {
      const output = outputs[index];
      if (!output || perCall < 20) return header;
      const lines = output.split("\n").slice(-10).join("\n");
      const tail = lines.length > perCall ? `…${lines.slice(-(perCall - 1))}` : lines;
      return `${header}\n${codeBlock(tail.toWellFormed())}`;
    })
    .join("\n");
}

function sessionEmbed(agent: Agent, view: ConversationView): EmbedBuilder {
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
    .setTitle("Session status")
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
  const content: (TextContent | ImageContent)[] = [
    { type: "text", text: `${message.author.username}: ${message.content.trim()}` },
  ];
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
