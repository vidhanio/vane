import { contentText, Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  defineEntry,
  defineTool,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Tx,
} from "@earendil-works/pi-durable";
import { resolve } from "node:path";
import { attachmentCountLimit, type ReplyRequest } from "./attachments.ts";

const ReplyManifest = defineEntry<ReplyRequest & { answer: EntryId }>("vane.reply");

export const replyTool = defineTool({
  name: "reply",
  description:
    "Send your final reply and optional local files to the user, ending the turn. Call this alone, after all other tools have finished. Only attach files the user requested; never attach credentials or secrets. Delivery happens after this call, so do not claim an upload has succeeded.",
  parameters: Type.Object(
    {
      text: Type.String({ description: "The final user-facing reply text." }),
      attachments: Type.Array(
        Type.String({
          minLength: 1,
          description: "Local file path, absolute or relative to the working directory. Not a URL.",
        }),
        {
          maxItems: attachmentCountLimit,
          description: "Files to upload, or [] for a text-only reply.",
        },
      ),
    },
    { additionalProperties: false },
  ),
  callers: ["model"],
  replay: "safe",
  async execute(args, api, context) {
    const cwd = api.env?.cwd ?? (await api.agent(context)).cwd ?? process.cwd();
    const attachments = [...new Set(args.attachments.map((path) => resolve(cwd, path)))];
    await api.commit(async (tx) => {
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanEntries({ conversationId: api.conversationId }, 100, cursor);
        for (const entry of page.items) {
          if (ReplyManifest.is(entry) && entry.byTaskId === api.taskId) return;
          if (!AssistantEntry.is(entry)) continue;
          const calls = entry.model?.flatMap((message) =>
            message.role === "assistant"
              ? message.content.filter((block) => block.type === "toolCall")
              : [],
          );
          if (calls?.length !== 1 || calls[0]?.id !== api.callId)
            throw new Error("Call reply alone, after all other tools have finished.");
          await tx.appendEntry(ReplyManifest, api.conversationId, {
            data: { answer: entry.id, text: args.text, attachments },
          });
          return;
        }
        cursor = page.next;
      } while (cursor);
      throw new Error("Missing assistant entry for reply.");
    }, context);
    return {
      output: [{ type: "text", text: "Reply saved for delivery." }],
      control: { terminate: true },
    };
  },
});

export async function readReply(tx: Tx, answer: EntryRecord): Promise<ReplyRequest> {
  const structured = answer.model?.some(
    (message) =>
      message.role === "assistant" &&
      message.content.some((block) => block.type === "toolCall" && block.name === replyTool.name),
  );
  if (structured) {
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanEntries(
        { conversationId: answer.conversationId, minEntryId: answer.id, order: "ascending" },
        100,
        cursor,
      );
      for (const entry of page.items) {
        if (ReplyManifest.is(entry) && entry.data.answer === answer.id) return entry.data;
        if (AssistantEntry.is(entry) && entry.id !== answer.id)
          throw new Error(`Missing reply manifest for answer ${answer.id}`);
      }
      cursor = page.next;
    } while (cursor);
    throw new Error(`Missing reply manifest for answer ${answer.id}`);
  }
  return {
    text:
      answer.model
        ?.flatMap((message) => (message.role === "assistant" ? [contentText(message.content)] : []))
        .join("\n") ?? "",
    attachments: [],
  };
}
