import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  LiveDoc,
  UsageDoc,
  type Agent,
  type ConversationView,
  type LiveState,
  type UsageState,
} from "@earendil-works/pi-durable";
import {
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
  type ChatInputCommandInteraction,
  type DMChannel,
  type PartialDMChannel,
  type Message,
} from "discord.js";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import type { Bot } from "../bot.ts";
import { log } from "../log.ts";
import type { DirectMessageIntegration, MessageOrigin, ToolActivity } from "../session.ts";
import { messageContent } from "./discord-content.ts";
import { splitMessages } from "./discord-text.ts";

const context = BACKGROUND_CONTEXT;
const configSchema = z.strictObject({
  token: z.string().min(1),
  allowed_user_ids: z.array(z.string().regex(/^\d{17,20}$/)).min(1),
});

const commands = (
  [
    ["stop", "stop the current response and cancel queued messages"],
    ["status", "show the shared session's activity, model and usage"],
    ["tools", "toggle keeping tool-call messages after responses"],
    ["reset", "cancel all work and reset the shared session"],
  ] as const
).map(([name, description]) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.BotDM),
);

export class Discord implements DirectMessageIntegration {
  readonly name = "discord";
  private readonly client = new Client({
    intents: [GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
    allowedMentions: { parse: [], repliedUser: false },
  });
  private readonly config: z.infer<typeof configSchema>;
  private stopping = true;
  private readonly running = new Set<Promise<void>>();
  private readonly progressText = new Map<string, string>();
  private typing: { channelId: string; controller: AbortController } | undefined;

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
      if (
        this.stopping ||
        message.channel.type !== ChannelType.DM ||
        message.author.bot ||
        !this.config.allowed_user_ids.includes(message.author.id)
      )
        return;
      if (!message.content.trim() && !message.attachments.size) return;
      this.track(
        this.bot.session
          .submit(
            { platform: this.name, channelId: message.channelId, messageId: message.id },
            (signal) => messageContent(message, signal),
          )
          .catch(async (error: unknown) => {
            console.error("Discord submission failed", error);
            await this.reply(
              { platform: this.name, channelId: message.channelId, messageId: message.id },
              errorText(error),
              `submission:${message.id}:error`,
            );
          }),
      );
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!this.stopping && interaction.isChatInputCommand())
        this.track(this.handleCommand(interaction));
    });
    await this.client.login(this.config.token);
    await ready;
    if (!this.client.application) throw new Error("Discord application is unavailable");
    await this.client.application.commands.set(commands.map((command) => command.toJSON()));
    this.stopping = false;
    this.bot.session.connect(this);
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

  async progress(
    origin: MessageOrigin,
    calls: ToolActivity[],
    ids: string[],
    key: string,
  ): Promise<string[]> {
    const channel = await this.channel(origin.channelId);
    const parts = splitMessages(calls.map(toolText).join("\n"));
    const updated: string[] = [];
    for (const [index, content] of parts.entries()) {
      const id = ids[index];
      if (id && this.progressText.get(id) === content) {
        updated.push(id);
        continue;
      }
      let message: Message | undefined;
      if (id) {
        try {
          message = await channel.messages.edit(id, { content });
        } catch (error) {
          if (!unknownMessage(error)) throw error;
          this.progressText.delete(id);
        }
      }
      if (!message) {
        message = await channel.send({
          content,
          nonce: nonce(`${key}:${index}`),
          enforceNonce: true,
        });
        if (message.content !== content)
          message = await channel.messages.edit(message.id, { content });
        this.refreshTyping();
      }
      this.progressText.set(message.id, content);
      updated.push(message.id);
    }
    await this.removeProgress(origin, ids.slice(parts.length));
    return updated;
  }

  async removeProgress(origin: MessageOrigin, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const channel = await this.channel(origin.channelId);
    for (const id of ids) {
      try {
        await channel.messages.delete(id);
      } catch (error) {
        if (!unknownMessage(error)) throw error;
      }
      this.progressText.delete(id);
    }
  }

  async reply(origin: MessageOrigin, text: string, key: string): Promise<void> {
    const channel = await this.channel(origin.channelId);
    for (const [index, content] of splitMessages(text).entries()) {
      await channel.send({
        content,
        ...(index === 0
          ? { reply: { messageReference: origin.messageId, failIfNotExists: false } }
          : {}),
        nonce: nonce(`${key}:${index}`),
        enforceNonce: true,
      });
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
          await this.bot.session.stop();
          await interaction.editReply("Response stopped; queued messages cancelled.");
          break;
        case "reset":
          await this.bot.session.reset();
          await interaction.editReply("Shared session reset.");
          break;
        case "tools":
          await interaction.editReply(
            (await this.bot.session.toggleTools())
              ? "Tools on: tool-call messages will stay in the channel."
              : "Tools off: tool-call messages will be deleted before responses.",
          );
          break;
        case "status":
          await interaction.editReply({
            embeds: [
              conversationEmbed(
                await this.bot.session.conversation.agent(context),
                this.bot.session.view.value,
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

function unknownMessage(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === 10008;
}

function codeText(text: string): string {
  return stripVTControlCharacters(text).replaceAll("`", "`\u200b").toWellFormed();
}

function errorText(error: unknown): string {
  return `ERROR:\n${codeBlock(codeText(error instanceof Error ? error.message : String(error)))}`;
}

function inline(value: unknown): string {
  return `\`${stripVTControlCharacters(typeof value === "string" ? value : "")
    .replaceAll("`", "")
    .replace(/\s+/g, " ")
    .trim()
    .toWellFormed()}\``;
}

function toolText(call: ToolActivity): string {
  const args = call.arguments;
  if (call.name === "codemode")
    return codeBlock("js", codeText(typeof args.code === "string" ? args.code : ""));
  const parsed = z
    .object({ agent: z.string().optional(), workspace: z.string().optional() })
    .safeParse(call.details);
  const agent = inline(
    parsed.success
      ? (parsed.data.agent ?? args.agent_target ?? args.agent_name)
      : (args.agent_target ?? args.agent_name),
  );
  const workspace = parsed.success
    ? (parsed.data.workspace ?? args.workspace_id)
    : args.workspace_id;
  const location = typeof workspace === "string" ? ` in ${inline(workspace)}` : "";
  let text: string;
  switch (call.name) {
    case "read":
      text = `reading ${inline(args.path)}`;
      break;
    case "edit":
      text = `editing ${inline(args.path)}`;
      break;
    case "write":
      text = `writing ${inline(args.path)}`;
      break;
    case "bash":
      text = `running ${inline(args.command)}`;
      break;
    case "herdr_list":
      text = "getting herdr status";
      break;
    case "herdr_create_workspace":
      text = `creating workspace ${inline(args.workspace_name)} at ${inline(args.project_path)}`;
      break;
    case "herdr_create_agent":
      text = `creating agent ${agent}${location}`;
      break;
    case "herdr_delegate":
      text = `delegating to ${agent}${location}`;
      break;
    case "herdr_subscribe":
      text = `subscribing to ${agent}${location}`;
      break;
    case "herdr_read":
      text = `reading status of ${agent}${location}`;
      break;
    default:
      text = `using ${inline(call.name)}`;
  }
  return `-# ${text}`;
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
    .setTitle("Shared session status")
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
