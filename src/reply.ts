import { Type } from "@earendil-works/pi-ai";
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
    "Send every final answer with this tool, ending the turn. Call it alone after other tools finish. Attach only user-requested local files, never credentials or secrets. Delivery is deferred; do not claim an upload succeeded.",
  parameters: Type.Object(
    {
      text: Type.String({ description: "The final user-facing reply text." }),
      attachments: Type.Array(
        Type.String({
          minLength: 1,
          description:
            "Literal local path, absolute or relative to the working directory—not a URL.",
        }),
        {
          maxItems: attachmentCountLimit,
          description: "[] for text only. Maximum 10 files, 10 MiB per file, 20 MiB total.",
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

export class MissingReplyManifest extends Error {
  constructor(answer: EntryId) {
    super(`Missing reply manifest for answer ${answer}`);
  }
}

export async function readReply(tx: Tx, answer: EntryRecord): Promise<ReplyRequest> {
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
        throw new MissingReplyManifest(answer.id);
    }
    cursor = page.next;
  } while (cursor);
  throw new MissingReplyManifest(answer.id);
}
