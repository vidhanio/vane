import { codeBlock, escapeMarkdown, type Attachment as DiscordAttachment } from "discord.js";
import { stripVTControlCharacters } from "node:util";
import { herdrProgressSchema } from "../herdr.ts";
import type { Attachment, ToolCallDetails, ToolCallEvent } from "../platform.ts";
import { log } from "../log.ts";

export const messageLimit = 1900;
const imageLimit = 10 * 1024 * 1024;
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function codeText(text: string): string {
  return stripVTControlCharacters(text).replaceAll("`", "`\u200b");
}

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `ERROR:\n${codeBlock(codeText(message).toWellFormed())}`;
}

function detailText(details: ToolCallDetails): string {
  switch (details.tool) {
    case "bash": {
      const command = details.command.replace(/\s+/g, " ").trim();
      return command.length > 50 ? `${command.slice(0, 49)}…` : command;
    }
    case "read":
    case "write":
    case "edit":
      return details.path;
    case "herdr": {
      const target = details.agent ?? details.name;
      return target === undefined ? details.action : `${details.action} ${target}`;
    }
  }
}

function toolOutput(event: ToolCallEvent): string {
  if (event.name === "bash") return event.output ?? "";
  if (event.name !== "herdr") return "";
  const parsed = herdrProgressSchema.safeParse(event.resultDetails);
  if (!parsed.success) return event.output ?? "";
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

export function renderToolLog(events: readonly ToolCallEvent[]): string {
  const headers = events.map((event) => {
    const detail = event.details ? detailText(event.details) : "";
    const label = `${event.name}${detail ? ` — ${detail}` : ""}`.replace(/\s+/g, " ");
    return `*${escapeMarkdown(label.slice(0, 140).toWellFormed())}*`;
  });
  const outputs = events.map((event) => codeText(toolOutput(event)));
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

export async function readAttachment(
  item: DiscordAttachment,
  images: boolean,
): Promise<Attachment> {
  const attachment: Attachment = { url: item.url, name: item.name };
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
