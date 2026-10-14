import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import {
  ChannelType,
  Client,
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
import { z } from "zod";
import { log } from "../log.ts";
import type { Platform, PlatformDefinition, PlatformHost } from "../platform.ts";
import { errorText, readAttachment, responseOptions, sessionEmbed } from "./discord-content.ts";
import { DiscordSession } from "./discord-session.ts";

const platformName = "discord";
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
  private channel: TextChannel | undefined;
  private stopping = false;
  private readonly running = new Set<Promise<void>>();
  private readonly incoming = new Map<string, Promise<void>>();
  private readonly sessions = new Map<string, Promise<DiscordSession>>();

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
    for (const id of await host.sessions()) {
      try {
        const thread = this.sessionThread(await this.client.channels.fetch(id));
        if (!thread) continue;
        const conversation = await host.find(id);
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
    const admission = Promise.withResolvers<void>();
    const previous = this.incoming.get(thread.id);
    this.incoming.set(thread.id, admission.promise);
    try {
      await previous;
      const conversation = await this.agent.conversation(thread.id);
      await this.attach(thread, conversation);
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
      await this.agent.submit({
        session: thread.id,
        id: message.id,
        author: message.author.username,
        text: content,
        attachments,
      });
    } catch (error) {
      console.error(`Session ${thread.id} failed`, error);
      if (!this.stopping) await thread.send(responseOptions(errorText(error)));
    } finally {
      admission.resolve();
      if (this.incoming.get(thread.id) === admission.promise) this.incoming.delete(thread.id);
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
      const conversation = thread ? await this.agent.find(thread.id) : undefined;
      if (!conversation) {
        await interaction.editReply("Use this command in a managed session thread.");
        return;
      }
      switch (interaction.commandName) {
        case "stop":
          await conversation.abort(context);
          await interaction.deleteReply();
          return;
        case "status":
          await interaction.editReply({ embeds: [await sessionEmbed(conversation)] });
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

export const discordPlatform: PlatformDefinition = {
  name: platformName,
  create: (raw) => new Discord(configSchema.parse(raw)),
};
