import { Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  defineDoc,
  defineEntry,
  defineTool,
  ToolTask,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Tx,
} from "@earendil-works/pi-durable";
import { resolve } from "node:path";
import { attachmentCountLimit, type ReplyRequest } from "./attachments.ts";

const ReplyManifest = defineEntry<ReplyRequest & { answer: EntryId }>("vane.reply");
const ReplyReceipt = defineDoc<{ saved: boolean }>({
  kind: "vane.reply.receipt",
  version: 1,
  scope: "task",
  initial: () => ({ saved: false }),
});

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
      const receipt = await tx.doc(ReplyReceipt, api.taskId);
      if (receipt.saved) return;
      const task = await tx.task(api.taskId);
      const input = task?.kind === ToolTask.definition.name ? task?.input : undefined;
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        input.kind !== "model" ||
        typeof input.assistant !== "number"
      )
        throw new Error("Missing model tool task for reply.");
      const entry = await tx.entry(AssistantEntry, input.assistant as EntryId);
      if (!entry) throw new Error("Missing assistant entry for reply.");
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
      receipt.saved = true;
    }, context);
    return {
      output: [{ type: "text", text: "Reply saved for delivery." }],
      control: { terminate: true },
    };
  },
});

export async function readReply(tx: Tx, answer: EntryRecord): Promise<ReplyRequest | undefined> {
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries(
      { conversationId: answer.conversationId, minEntryId: answer.id, order: "ascending" },
      100,
      cursor,
    );
    for (const entry of page.items) {
      if (ReplyManifest.is(entry) && entry.data.answer === answer.id) return entry.data;
      if (AssistantEntry.is(entry) && entry.id !== answer.id) return undefined;
    }
    cursor = page.next;
  } while (cursor);
  return undefined;
}

export function answerText(answer: EntryRecord): ReplyRequest | undefined {
  const text = (answer.model ?? [])
    .flatMap((message) => (message.role === "assistant" ? message.content : []))
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n")
    .trim();
  return text ? { text, attachments: [] } : undefined;
}
