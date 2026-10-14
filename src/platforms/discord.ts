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

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `ERROR:\n\`\`\`\n${message}\n\`\`\``;
}

interface ToolLine {
  callId: string;
  text: string;
}

interface ToolLog {
  message?: Message | undefined;
  lines: ToolLine[];
  chain: Promise<void>;
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
  private readonly turns = new Map<string, Promise<void>>();
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
    switch (event.type) {
      case "turn-start":
        this.startTyping(event.session.id);
        this.logs.set(event.session.id, { lines: [], chain: Promise.resolve() });
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
    const previous = this.turns.get(thread.id) ?? Promise.resolve();
    const current = previous.then(() => this.run(thread, message, content));
    const guarded = current.catch(() => undefined);
    this.turns.set(thread.id, guarded);
    void guarded.finally(() => {
      if (this.turns.get(thread.id) === guarded) this.turns.delete(thread.id);
    });
    await current;
  }

  private async run(thread: ThreadChannel, message: Message, content: string): Promise<void> {
    const session: SessionRef = { platform: this.name, id: thread.id };
    try {
      const answer = await this.agent.ask({
        session,
        id: message.id,
        author: message.author.username,
        text: content,
        attachments: [...message.attachments.values()].map((item) => ({
          url: item.url,
          name: item.name,
        })),
      });
      await this.finish(thread.id, thread, `${message.id}:answer`, answer);
    } catch (error) {
      console.error(`Session ${thread.id} failed`, error);
      if (!this.stopping)
        await this.finish(thread.id, thread, `${message.id}:error`, errorText(error));
    }
  }

  private appendTool(event: ToolCallEvent): void {
    const log = this.logs.get(event.session.id);
    if (!log) return;
    const text =
      event.summary === undefined ? `*${event.name}*` : `*${event.name} — ${event.summary}*`;
    void this.enqueue(log, async () => {
      const existing = log.lines.find((line) => line.callId === event.callId);
      if (existing) {
        if (existing.text === text) return;
        existing.text = text;
      } else {
        log.lines.push({ callId: event.callId, text });
        if (log.lines.length > 5) log.lines.shift();
      }
      await this.showLog(event.session.id, log);
    });
  }

  private enqueue(log: ToolLog, task: () => Promise<void>): Promise<void> {
    const next = log.chain.then(task);
    log.chain = next.catch((error: unknown) => console.error("Tool log update failed", error));
    return next;
  }

  private async showLog(sessionId: string, log: ToolLog): Promise<void> {
    const content = log.lines.map((line) => line.text).join("\n");
    if (log.message) {
      try {
        await log.message.edit({ content });
        return;
      } catch (error) {
        console.error("Tool message edit failed", error);
        log.message = undefined;
      }
    }
    const thread = await this.sessionChannel(sessionId);
    log.message = await thread.send({ content });
  }

  private async sessionChannel(id: string): Promise<ThreadChannel> {
    const channel = await this.client.channels.fetch(id);
    if (!channel?.isThread()) throw new Error(`Session ${id} is not a thread`);
    if (channel.archived) await channel.setArchived(false);
    return channel;
  }

  private async finish(
    sessionId: string,
    thread: ThreadChannel,
    fallbackId: string,
    text: string,
  ): Promise<void> {
    const log = this.logs.get(sessionId);
    if (!log) {
      await this.send(thread, fallbackId, text);
      return;
    }
    await this.enqueue(log, async () => {
      if (log.message) {
        try {
          await this.editMessage(log.message, text);
          return;
        } catch (error) {
          console.error("Tool message edit failed", error);
          log.message = undefined;
        }
      }
      await this.send(thread, fallbackId, text);
    });
  }

  private async editMessage(message: Message, text: string): Promise<void> {
    if (text.length <= 1900) await message.edit({ content: text });
    else
      await message.edit({
        content: "",
        files: [new AttachmentBuilder(Buffer.from(text), { name: "response.md" })],
      });
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
          await interaction.editReply("Stopped the current response.");
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
        files: [new AttachmentBuilder(Buffer.from(text), { name: "response.md" })],
      });
  }
}

export const discordPlatform: PlatformDefinition = {
  name: platformName,
  create: (raw) => new Discord(configSchema.parse(raw)),
};
