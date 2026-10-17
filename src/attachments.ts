import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename } from "node:path";

export const attachmentCountLimit = 10;
export const attachmentLimit = 10 * 1024 * 1024;
export const attachmentTotalLimit = 20 * 1024 * 1024;
export type ReplyRequest = { text: string; attachments: string[] };
type ReplyAttachment = { name: string; data: Buffer };
export type Reply = { text: string; attachments?: ReplyAttachment[] };

export async function prepareReply(reply: ReplyRequest, signal: AbortSignal): Promise<Reply> {
  signal.throwIfAborted();
  const lines = [reply.text];
  const attachments: ReplyAttachment[] = [];
  const paths = new Set<string>();
  let total = 0;
  for (const requested of reply.attachments) {
    signal.throwIfAborted();
    try {
      if (sensitivePath(requested)) throw new Error("credential files cannot be attached");
      const path = await realpath(requested).catch(() => {
        throw new Error("could not resolve file");
      });
      if (sensitivePath(path)) throw new Error("credential files cannot be attached");
      if (paths.has(path)) continue;
      paths.add(path);
      if (paths.size > attachmentCountLimit) throw new Error("maximum 10 attachments per reply");
      const data = await readAttachment(
        path,
        Math.min(attachmentLimit, attachmentTotalLimit - total),
        signal,
      );
      if (containsSecret(data)) throw new Error("file appears to contain credentials or secrets");
      total += data.length;
      attachments.push({ name: basename(requested), data });
    } catch (error) {
      signal.throwIfAborted();
      const reason = error instanceof Error ? error.message : "could not read file";
      lines.push(`Attachment unavailable (${basename(requested)}): ${reason}`);
    }
  }
  signal.throwIfAborted();
  return {
    text: lines.join("\n").trim() || (attachments.length ? "" : "Completed with no text response."),
    attachments,
  };
}

const credentialNames = new Set([
  ".env",
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  "auth.json",
  "credentials",
]);

function sensitivePath(path: string): boolean {
  return path.split("/").some((part) => {
    const name = part.toLowerCase();
    return (
      credentialNames.has(name) ||
      name.startsWith(".env.") ||
      name.startsWith("credentials.") ||
      /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(name) ||
      /\.(?:pem|key|p12|pfx)$/.test(name)
    );
  });
}

function containsSecret(data: Buffer): boolean {
  if (/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/.test(data.toString("utf8"))) return true;
  return Object.entries(process.env).some(
    ([name, value]) =>
      /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|(?:^|_)KEY)(?:_|$)/i.test(name) &&
      value !== undefined &&
      value.length >= 8 &&
      data.includes(value),
  );
}

async function readAttachment(path: string, limit: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  ).catch(() => {
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
