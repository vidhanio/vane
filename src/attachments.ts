import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, resolve } from "node:path";

export const attachmentLimit = 10 * 1024 * 1024;
export const attachmentTotalLimit = 20 * 1024 * 1024;
export type ReplyAttachment = { name: string; data: Buffer };
export type Reply = { text: string; attachments?: ReplyAttachment[] };

export async function prepareReply(text: string, cwd: string, signal: AbortSignal): Promise<Reply> {
  const lines: string[] = [];
  const attachments: ReplyAttachment[] = [];
  const paths = new Set<string>();
  let total = 0;
  let fence: { character: string; length: number } | undefined;
  for (const line of text.split("\n")) {
    signal.throwIfAborted();
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter?.[1]) {
      const marker = delimiter[1];
      if (!fence) fence = { character: marker.startsWith("`") ? "`" : "~", length: marker.length };
      else if (
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        !delimiter[2]?.trim()
      )
        fence = undefined;
      lines.push(line);
      continue;
    }
    const link = fence
      ? null
      : /^ {0,3}!?\[([^\]\n]*)\]\((?:<attachment:([^>\n]+)>|attachment:([^\s)]+))\)[ \t]*$/.exec(
          line,
        );
    if (!link) {
      lines.push(line);
      continue;
    }
    const label = link[1] || "file";
    try {
      const path = resolve(cwd, decodeURIComponent(link[2] ?? link[3] ?? ""));
      if (paths.has(path)) continue;
      paths.add(path);
      if (paths.size > 10) throw new Error("maximum 10 attachments per reply");
      const data = await readAttachment(
        path,
        Math.min(attachmentLimit, attachmentTotalLimit - total),
        signal,
      );
      total += data.length;
      attachments.push({ name: basename(path), data });
    } catch (error) {
      signal.throwIfAborted();
      const reason = error instanceof Error ? error.message : "could not read file";
      lines.push(`Attachment unavailable (${label}): ${reason}`);
    }
  }
  return {
    text: lines.join("\n").trim() || (attachments.length ? "" : "Completed with no text response."),
    attachments,
  };
}

async function readAttachment(path: string, limit: number, signal: AbortSignal): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
    throw new Error("could not open file");
  });
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("not a regular file");
    if (info.size > limit) throw new Error("exceeds the 10 MiB/file or 20 MiB/reply limit");
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit - size + 1));
      const { bytesRead } = await file.read(chunk, 0, chunk.length);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new Error("exceeds the 10 MiB/file or 20 MiB/reply limit");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await file.close();
  }
}
