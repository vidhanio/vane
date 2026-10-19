import { copyJson } from "@earendil-works/chord";
import {
  defineDoc,
  defineEntry,
  defineExtension,
  wrapTool,
  type JsonObject,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { replyTool } from "./reply.ts";

export const ToolAdmission = defineEntry<{ id: string; name: string; arguments: JsonObject }>(
  "vane.tool.admission",
);
const Notice = defineDoc<{ recorded: boolean }>({
  kind: "vane.tool.notice",
  version: 1,
  scope: "task",
  initial: () => ({ recorded: false }),
});

export function toolNotices(tools: readonly ToolRegistration[]) {
  return defineExtension({
    name: "vane.tool.notices",
    wraps: tools
      .filter((tool) => tool.name !== replyTool.name)
      .map((tool) =>
        wrapTool(tool, (original) => ({
          ...original,
          execute: async (args, api, context) => {
            await api.commit(async (tx) => {
              const notice = await tx.doc(Notice, api.taskId);
              if (notice.recorded) return;
              await tx.appendEntry(ToolAdmission, api.conversationId, {
                data: {
                  id: api.callId,
                  name: original.name,
                  arguments: copyJson(args) as JsonObject,
                },
              });
              notice.recorded = true;
            }, context);
            return original.execute(args, api, context);
          },
        })),
      ),
  });
}
