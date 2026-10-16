import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { UserInput } from "@earendil-works/pi-durable";
import type { Attachment, Message } from "discord.js";
import { log } from "../../log.ts";

const imageLimit = 10 * 1024 * 1024;
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export async function messageContent(message: Message, signal: AbortSignal): Promise<UserInput> {
  const content: (TextContent | ImageContent)[] = [{ type: "text", text: message.content.trim() }];
  let imageBytes = 0;
  let imageCount = 0;
  for (const item of message.attachments.values()) {
    signal.throwIfAborted();
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
    const image = await readImage(item, includeImage, signal);
    if (image) content.push(image);
  }
  return content;
}

async function readImage(
  item: Attachment,
  images: boolean,
  signal: AbortSignal,
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
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      redirect: "error",
    });
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
    signal.throwIfAborted();
    console.error("Discord image download failed", { attachmentId: item.id, error });
    return undefined;
  }
}
