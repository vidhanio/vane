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
  type Channel,
  type ChatInputCommandInteraction,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  BotEvent,
  Platform,
  PlatformDefinition,
  PlatformHost,
  SessionInfo,
  SessionRef,
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
    .setName("reset")
    .setDescription("Start a fresh context in this session")
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show this session's activity, model and usage")
    .setContexts(InteractionContextType.Guild),
];

const nonce = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 24);

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
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const timer of this.typing.values()) clearInterval(timer);
    this.typing.clear();
    await Promise.allSettled(this.running);
    await this.client.destroy();
  }

  private onEvent(event: BotEvent): void {
    if (event.type === "turn-start") this.startTyping(event.session.id);
    else this.stopTyping(event.session.id);
  }

  private startTyping(id: string): void {
    if (this.typing.has(id)) return;
    const ping = () => {
      void this.client.channels
        .fetch(id)
        .then((channel) => (channel?.isThread() ? channel.sendTyping() : undefined))
        .catch(() => undefined);
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
    const thread = message.channel.isThread() ? message.channel : await this.thread(message);
    const session: SessionRef = { platform: this.name, id: thread.id };
    try {
      const [answer] = await Promise.all([
        this.agent.ask({
          session,
          id: message.id,
          author: message.author.username,
          text: content,
          attachments: [...message.attachments.values()].map((item) => ({
            url: item.url,
            name: item.name,
          })),
        }),
        this.send(thread, `${message.id}:ack`, "Working on this."),
      ]);
      await this.send(thread, `${message.id}:answer`, answer);
    } catch (error) {
      console.error(`Session ${thread.id} failed`, error);
      if (!this.stopping)
        await this.send(
          thread,
          `${message.id}:error`,
          "Could not finish this request. Check the service logs or send another message to continue.",
        );
    }
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
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
    if (!thread) {
      await interaction.reply({
        content: `Use this command in a session thread under <#${this.config.channel_id}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const session: SessionRef = { platform: this.name, id: thread.id };
      const status = await this.agent.status(session);
      if (!status) {
        await interaction.editReply("No session has started in this thread yet.");
        return;
      }
      switch (interaction.commandName) {
        case "stop":
          await this.agent.stop(session);
          await interaction.editReply(
            "Stopped the current response. External workers keep running.",
          );
          return;
        case "reset":
          await this.agent.reset(session);
          await interaction.editReply("Started a fresh context. Earlier history is kept.");
          return;
        case "status":
          await interaction.editReply({ embeds: [this.sessionEmbed(status)] });
          return;
        default:
          await interaction.editReply("Unknown command.");
      }
    } catch (error) {
      console.error(`Command ${interaction.commandName} failed`, error);
      await interaction
        .editReply("Something went wrong. Check the service logs.")
        .catch(() => undefined);
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
    const starter = await message.fetch();
    return (
      starter.thread ??
      (await starter.startThread({
        name: message.content.replace(/\s+/g, " ").slice(0, 100) || "New session",
        autoArchiveDuration: 1440,
      }))
    );
  }

  private async send(thread: ThreadChannel, id: string, text: string): Promise<void> {
    if (thread.archived) await thread.setArchived(false);
    const options = { nonce: nonce(id), enforceNonce: true };
    if (text.length <= 1900) await thread.send({ ...options, content: text });
    else
      await thread.send({
        ...options,
        content: `${text.slice(0, 1700)}\n\nFull response attached.`,
        files: [new AttachmentBuilder(Buffer.from(text), { name: "response.md" })],
      });
  }
}

export const discordPlatform: PlatformDefinition = {
  name: platformName,
  create: (raw) => new Discord(configSchema.parse(raw)),
};
