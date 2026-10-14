import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Colors,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type Channel,
  type ChatInputCommandInteraction,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { createHash } from "node:crypto";
import { Mutex } from "async-mutex";
import { log } from "../log.ts";
import { errorText, messageLimit, readAttachment, renderToolLog } from "./discord-content.ts";
import { z } from "zod";
import type {
  BotEvent,
  Platform,
  PlatformDefinition,
  PlatformHost,
  SessionInfo,
  SessionRef,
  ToolCallEvent,
} from "../platform.ts";

const platformName = "discord";

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

const nonce = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 24);

interface TurnQueue {
  mutex: Mutex;
  users: number;
  thread: ThreadChannel;
}

interface ToolLog {
  message?: Message | undefined;
  lines: ToolCallEvent[];
  seen: Set<string>;
  chain: Promise<void>;
  timer?: ReturnType<typeof setTimeout> | undefined;
  closing: boolean;
}

class Discord implements Platform {
  readonly name = platformName;
  private readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    allowedMentions: { parse: [], repliedUser: false },
  });
  private host: PlatformHost | undefined;
  private unsubscribe: (() => void) | undefined;
  private channel: TextChannel | undefined;
  private stopping = false;
  private readonly running = new Set<Promise<void>>();
  private readonly typing = new Map<string, ReturnType<typeof setInterval>>();
  private readonly turns = new Map<string, TurnQueue>();
  private readonly logs = new Map<string, ToolLog>();

  constructor(private readonly config: DiscordConfig) {}

  private get agent(): PlatformHost {
    if (!this.host) throw new Error("Discord platform has not started");
    return this.host;
  }

  async start(host: PlatformHost): Promise<void> {
    this.host = host;
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
    this.unsubscribe = host.subscribe((event) => this.onEvent(event));
    log("discord.connected", {
      guildId: guild.id,
      channelId: channel.id,
      userId: this.client.user?.id,
    });
  }

  async stop(): Promise<void> {
    log("discord.stopping", { activeTurns: this.running.size });
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const timer of this.typing.values()) clearInterval(timer);
    this.typing.clear();
    await Promise.allSettled(this.running);
    for (const entry of this.logs.values()) if (entry.timer) clearTimeout(entry.timer);
    this.logs.clear();
    await this.client.destroy();
    log("discord.disconnected");
  }

  private onEvent(event: BotEvent): void {
    switch (event.type) {
      case "turn-start":
        this.startTyping(event.session.id);
        this.logs.set(event.session.id, {
          lines: [],
          seen: new Set(),
          chain: Promise.resolve(),
          closing: false,
        });
        return;
      case "tool-call":
        this.appendTool(event);
        return;
      case "turn-end":
      case "turn-error":
        this.stopTyping(event.session.id);
        return;
    }
  }

  private startTyping(id: string): void {
    if (this.typing.has(id)) return;
    const thread = this.turns.get(id)?.thread ?? this.client.channels.cache.get(id);
    if (!thread?.isThread()) return;
    const ping = () => {
      void thread
        .sendTyping()
        .catch((error: unknown) =>
          console.error("Discord typing failed", { sessionId: id, error }),
        );
    };
    ping();
    this.typing.set(id, setInterval(ping, 8000));
  }

  private stopTyping(id: string): void {
    const timer = this.typing.get(id);
    if (timer !== undefined) clearInterval(timer);
    this.typing.delete(id);
  }

  private track(work: Promise<void>): void {
    const tracked = work
      .catch((error: unknown) => console.error("Discord work failed", error))
      .finally(() => this.running.delete(tracked));
    this.running.add(tracked);
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
    return channel.parentId === this.config.channel_id ? channel : undefined;
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
    const queue = this.turns.get(thread.id) ?? { mutex: new Mutex(), users: 0, thread };
    queue.users += 1;
    this.turns.set(thread.id, queue);
    try {
      await queue.mutex.runExclusive(() => this.run(thread, message, content));
    } finally {
      queue.users -= 1;
      if (queue.users === 0) this.turns.delete(thread.id);
    }
  }

  private async run(thread: ThreadChannel, message: Message, content: string): Promise<void> {
    const session: SessionRef = { platform: this.name, id: thread.id };
    this.startTyping(thread.id);
    try {
      let imageBytes = 0;
      let imageCount = 0;
      const attachments = [];
      for (const item of message.attachments.values()) {
        const image =
          item.contentType?.startsWith("image/") &&
          imageCount < 4 &&
          imageBytes + item.size <= 20 * 1024 * 1024;
        if (image) {
          imageCount += 1;
          imageBytes += item.size;
        }
        attachments.push(await readAttachment(item, Boolean(image)));
      }
      const answer = await this.agent.ask({
        session,
        id: message.id,
        author: message.author.username,
        text: content,
        attachments,
      });
      await this.finish(thread.id, thread, `${message.id}:answer`, answer);
    } catch (error) {
      this.stopTyping(thread.id);
      console.error(`Session ${thread.id} failed`, error);
      if (!this.stopping)
        await this.finish(thread.id, thread, `${message.id}:error`, errorText(error));
    }
  }

  private appendTool(event: ToolCallEvent): void {
    const entry = this.logs.get(event.session.id);
    if (!entry || entry.closing) return;
    const index = entry.lines.findIndex((line) => line.callId === event.callId);
    if (index >= 0) entry.lines[index] = event;
    else {
      if (entry.seen.has(event.callId)) return;
      entry.seen.add(event.callId);
      entry.lines.push(event);
      if (entry.lines.length > 5) entry.lines.shift();
    }
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.enqueue(entry, async () => {
        if (!entry.closing) await this.showLog(event.session.id, entry);
      }).catch(() => undefined);
    }, 750);
  }

  private enqueue(entry: ToolLog, task: () => Promise<void>): Promise<void> {
    const next = entry.chain.then(task);
    entry.chain = next.catch((error: unknown) => console.error("Tool log update failed", error));
    return next;
  }

  private async showLog(sessionId: string, entry: ToolLog): Promise<void> {
    const content = renderToolLog(entry.lines);
    if (!content || entry.message?.content === content) return;
    if (entry.message) {
      try {
        entry.message = await entry.message.edit({ content });
        return;
      } catch (error) {
        console.error("Tool message edit failed", error);
        entry.message = undefined;
      }
    }
    const thread = await this.sessionChannel(sessionId);
    entry.message = await thread.send({ content });
    log("discord.tool_log_created", { threadId: thread.id, messageId: entry.message.id });
  }

  private async sessionChannel(id: string): Promise<ThreadChannel> {
    const channel = this.turns.get(id)?.thread ?? (await this.client.channels.fetch(id));
    if (!channel?.isThread()) throw new Error(`Session ${id} is not a thread`);
    if (channel.archived) await channel.setArchived(false);
    return channel;
  }

  private async finish(
    sessionId: string,
    thread: ThreadChannel,
    fallbackId: string,
    text: string | undefined,
  ): Promise<void> {
    const entry = this.logs.get(sessionId);
    if (!entry) {
      if (text !== undefined) await this.send(thread, fallbackId, text);
      return;
    }
    entry.closing = true;
    if (entry.timer) clearTimeout(entry.timer);
    try {
      await this.enqueue(entry, async () => {
        if (text === undefined) {
          await entry.message
            ?.delete()
            .catch((error: unknown) => console.error("Could not remove stopped tool log", error));
          return;
        }
        if (entry.message) {
          try {
            await this.editMessage(entry.message, text);
            return;
          } catch (error) {
            console.error("Tool message edit failed", error);
            entry.message = undefined;
          }
        }
        await this.send(thread, fallbackId, text);
      });
    } finally {
      if (this.logs.get(sessionId) === entry) this.logs.delete(sessionId);
    }
  }

  private async editMessage(message: Message, text: string): Promise<void> {
    await message.edit(
      text.length <= messageLimit
        ? { content: text }
        : {
            content: "",
            files: [new AttachmentBuilder(Buffer.from(text), { name: "response.md" })],
          },
    );
    log("discord.response_edited", {
      messageId: message.id,
      channelId: message.channelId,
      textLength: text.length,
      attachment: text.length > messageLimit,
    });
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
    const thread = this.sessionThread(interaction.channel);
    const session: SessionRef | undefined = thread
      ? { platform: this.name, id: thread.id }
      : undefined;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const status = session ? await this.agent.status(session) : undefined;
      if (!session || !status) {
        await interaction.editReply("Use this command in a managed session thread.");
        return;
      }
      switch (interaction.commandName) {
        case "stop":
          await this.agent.stop(session);
          await interaction.deleteReply();
          return;
        case "status":
          await interaction.editReply({ embeds: [this.sessionEmbed(status)] });
          return;
        default:
          await interaction.editReply("Unknown command.");
      }
    } catch (error) {
      console.error(`Command ${interaction.commandName} failed`, error);
      await interaction.editReply(errorText(error)).catch(() => undefined);
    }
  }

  private sessionEmbed(status: SessionInfo): EmbedBuilder {
    return new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle("Session status")
      .addFields(
        { name: "Status", value: status.activity, inline: true },
        { name: "Model", value: `${status.provider}/${status.model}`, inline: true },
        { name: "Thinking", value: status.thinking, inline: true },
        {
          name: "Usage",
          value: `${status.tokens.toLocaleString("en-US")} tokens · $${status.cost.toFixed(4)}`,
          inline: true,
        },
        { name: "Directory", value: `\`${status.cwd}\``, inline: false },
      );
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

  private async send(thread: ThreadChannel, id: string, text: string): Promise<void> {
    if (thread.archived) await thread.setArchived(false);
    const options = { nonce: nonce(id), enforceNonce: true };
    const message = await thread.send(
      text.length <= messageLimit
        ? { ...options, content: text }
        : {
            ...options,
            files: [new AttachmentBuilder(Buffer.from(text), { name: "response.md" })],
          },
    );
    log("discord.response_sent", {
      threadId: thread.id,
      messageId: message.id,
      textLength: text.length,
      attachment: text.length > messageLimit,
    });
  }
}

export const discordPlatform: PlatformDefinition = {
  name: platformName,
  create: (raw) => new Discord(configSchema.parse(raw)),
};
