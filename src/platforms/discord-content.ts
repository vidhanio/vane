import {
  AttachmentBuilder,
  codeBlock,
  Colors,
  EmbedBuilder,
  escapeMarkdown,
  type Attachment as DiscordAttachment,
} from "discord.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  LiveDoc,
  UsageDoc,
  type Conversation,
  type ConversationView,
  type EntryId,
  type LiveState,
  type UsageState,
} from "@earendil-works/pi-durable";
import { stripVTControlCharacters } from "node:util";
import { herdrProgressSchema } from "../herdr.ts";
import type { Attachment } from "../platform.ts";
import { log } from "../log.ts";

export const messageLimit = 1900;
const imageLimit = 10 * 1024 * 1024;
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function responseOptions(text: string) {
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

export function errorText(error: unknown): string {
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

export function renderToolLog(view: ConversationView, input: EntryId): string {
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

export async function sessionEmbed(conversation: Conversation): Promise<EmbedBuilder> {
  const agent = await conversation.agent(BACKGROUND_CONTEXT);
  const view = await conversation.viewState(BACKGROUND_CONTEXT);
  const live = view.value.docs[LiveDoc.definition.kind] as LiveState | undefined;
  const usage = view.value.docs[UsageDoc.definition.kind] as UsageState | undefined;
  view.dispose();
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

export async function readAttachment(
  item: DiscordAttachment,
  images: boolean,
): Promise<Attachment> {
  const attachment: Attachment = { url: item.url };
  const mimeType = item.contentType?.split(";", 1)[0]?.toLowerCase();
  if (!images || !mimeType || !imageTypes.has(mimeType) || item.size > imageLimit)
    return attachment;
  const url = new URL(item.url);
  if (
    url.protocol !== "https:" ||
    !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
  )
    return attachment;
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
    return {
      ...attachment,
      image: { type: "image", data: Buffer.concat(chunks).toString("base64"), mimeType },
    };
  } catch (error) {
    console.error("Discord image download failed", { attachmentId: item.id, error });
    return attachment;
  }
}
