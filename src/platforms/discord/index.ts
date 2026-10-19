import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ChannelType,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  HTTPError,
  InteractionContextType,
  MessageFlags,
  Partials,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type DMChannel,
  type PartialDMChannel,
} from "discord.js";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Reply } from "../../attachments.ts";
import { log } from "../../log.ts";
import type { MessageOrigin } from "../../messages.ts";
import type { Session } from "../../session.ts";
import type { Platform, ToolActivity } from "../index.ts";
import { messageContent } from "./content.ts";
import { conversationEmbed, errorText, toolText } from "./presentation.ts";
import { splitMessages } from "./text.ts";

const context = BACKGROUND_CONTEXT;
const configSchema = z.strictObject({
  token: z.string().min(1),
  allowed_user_ids: z.array(z.string().regex(/^\d{17,20}$/)).min(1),
});

const commands = (
  [
    ["stop", "stop the current response and cancel queued messages"],
    ["status", "show the shared session's activity, model and usage"],
    ["tools", "enable or disable immutable tool notices"],
  ] as const
).map(([name, description]) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.BotDM),
);

export class Discord implements Platform {
  readonly name = "discord";
  private readonly client = new Client({
    intents: [GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
    allowedMentions: { parse: [], repliedUser: false },
  });
  private readonly config: z.infer<typeof configSchema>;
  private stopping = true;
  private readonly running = new Set<Promise<void>>();
  private typing: { channelId: string; controller: AbortController } | undefined;

  constructor(
    private readonly session: Session,
    config: unknown,
    private readonly attachmentDirectory: string,
  ) {
    this.config = configSchema.parse(config);
  }

  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const startup = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const ready = once(this.client, Events.ClientReady, { signal: startup });
    this.client.on(Events.Error, (error) => console.error("Discord error", error));
    this.client.on(Events.MessageCreate, (message) => {
      if (
        this.stopping ||
        message.channel.type !== ChannelType.DM ||
        message.author.bot ||
        !this.config.allowed_user_ids.includes(message.author.id)
      )
        return;
      if (!message.content.trim() && !message.attachments.size) return;
      this.track(
        this.session
          .submit(
            { platform: this.name, channelId: message.channelId, messageId: message.id },
            (preparation) => messageContent(message, preparation, this.attachmentDirectory),
          )
          .catch(async (error: unknown) => {
            console.error("Discord submission failed", error);
            await this.reply(
              { platform: this.name, channelId: message.channelId, messageId: message.id },
              { text: errorText(error) },
              `submission:${message.id}:error`,
            );
          }),
      );
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!this.stopping && interaction.isChatInputCommand())
        this.track(this.handleCommand(interaction));
    });
    await Promise.all([ready, this.client.login(this.config.token)]);
    startup.throwIfAborted();
    if (!this.client.application) throw new Error("Discord application is unavailable");
    await this.client.application.commands.set(commands.map((command) => command.toJSON()));
    startup.throwIfAborted();
    this.stopping = false;
    this.session.connect(this);
    log("discord.connected", { userId: this.client.user?.id });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.updateTyping(undefined);
    await Promise.allSettled(this.running);
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.updateTyping(undefined);
    await this.client.destroy();
    log("discord.disconnected");
  }

  setTyping(origin: MessageOrigin | undefined): void {
    this.updateTyping(this.stopping ? undefined : origin?.channelId);
  }

  async notice(origin: MessageOrigin, call: ToolActivity, key: string): Promise<void> {
    const channel = await this.channel(origin.channelId);
    for (const [index, content] of splitMessages(toolText(call)).entries()) {
      await channel.send({ content, nonce: nonce(`${key}:${index}`), enforceNonce: true });
    }
    this.refreshTyping();
  }

  async reply(origin: MessageOrigin, message: Reply, key: string): Promise<void> {
    const channel = await this.channel(origin.channelId);
    const parts = splitMessages(message.text);
    if (!parts.length && !message.attachments?.length) return;
    if (!parts.length) parts.push("");
    for (const [index, content] of parts.entries()) {
      const files = index === 0 ? message.attachments : undefined;
      try {
        await channel.send({
          ...(content ? { content } : {}),
          ...(files?.length
            ? { files: files.map((file) => ({ attachment: file.data, name: file.name })) }
            : {}),
          ...(index === 0
            ? { reply: { messageReference: origin.messageId, failIfNotExists: false } }
            : {}),
          nonce: nonce(`${key}:${index}`),
          enforceNonce: true,
        });
      } catch (error) {
        if (
          !files?.length ||
          !(error instanceof DiscordAPIError || error instanceof HTTPError) ||
          error.status < 400 ||
          error.status >= 500 ||
          error.status === 429
        )
          throw error;
        console.error("Discord attachment upload failed", error);
        await this.reply(
          origin,
          { text: `Attachment upload failed. Please try again.\n\n${message.text}`.trim() },
          `${key}:attachment-error`,
        );
        return;
      }
    }
  }

  private updateTyping(channelId: string | undefined): void {
    if (channelId === this.typing?.channelId) return;
    this.typing?.controller.abort();
    this.typing = undefined;
    if (!channelId) return;
    const controller = new AbortController();
    this.typing = { channelId, controller };
    void this.runTyping(channelId, controller.signal);
  }

  private refreshTyping(): void {
    const channelId = this.typing?.channelId;
    if (!channelId) return;
    this.updateTyping(undefined);
    this.updateTyping(channelId);
  }

  private async runTyping(channelId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const channel = await this.channel(channelId);
        if (!signal.aborted) await channel.sendTyping();
      } catch (error) {
        if (!signal.aborted) console.error("Discord typing failed", { channelId, error });
      }
      if (signal.aborted) return;
      await delay(8000, undefined, { signal }).catch(() => undefined);
    }
  }

  private async channel(channelId: string): Promise<DMChannel | PartialDMChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (
      channel?.type !== ChannelType.DM ||
      !channel.recipient ||
      !this.config.allowed_user_ids.includes(channel.recipient.id)
    )
      throw new Error(`Discord DM is unavailable: ${channelId}`);
    return channel;
  }

  private track(work: Promise<void>): void {
    const tracked = work
      .catch((error: unknown) => console.error("Discord work failed", error))
      .finally(() => this.running.delete(tracked));
    this.running.add(tracked);
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (
      interaction.guildId !== null ||
      !this.config.allowed_user_ids.includes(interaction.user.id)
    ) {
      await interaction.reply({
        content: "vane is not available to you.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      switch (interaction.commandName) {
        case "stop":
          await this.session.stop();
          await interaction.editReply("Response stopped; queued messages cancelled.");
          break;
        case "tools":
          await interaction.editReply(
            (await this.session.toggleTools())
              ? "Tools on: immutable tool notices are enabled."
              : "Tools off: new tool notices are disabled.",
          );
          break;
        case "status":
          await interaction.editReply({
            embeds: [
              conversationEmbed(
                await this.session.conversation.agent(context),
                this.session.view.value,
              ),
            ],
          });
          break;
        default:
          await interaction.editReply("Unknown command.");
      }
    } catch (error) {
      console.error(`Discord command ${interaction.commandName} failed`, error);
      const [first, ...rest] = splitMessages(errorText(error));
      await interaction.editReply(first ?? "An unknown error occurred.");
      for (const content of rest)
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    }
  }
}

function nonce(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}
