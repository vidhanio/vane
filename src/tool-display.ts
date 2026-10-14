import type { JsonValue } from "@earendil-works/chord";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
  validateToolArguments,
  type JsonObject,
  type Static,
  type TSchema,
} from "@earendil-works/pi-ai";
import type { ToolCallDetails } from "./platform.ts";

const descriptions = new WeakMap<TSchema, (args: JsonObject) => ToolCallDetails | undefined>();

export function describeTool(
  tool: ToolRegistration,
  args: JsonObject | undefined,
): ToolCallDetails | undefined {
  return args === undefined ? undefined : descriptions.get(tool.parameters)?.(args);
}

interface ToolDisplay {
  kind: "vidhan-bot.tool";
  call: ToolCallDetails;
  result?: JsonValue;
}

export function toolDisplay(value: unknown): ToolDisplay | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("kind" in value) ||
    value.kind !== "vidhan-bot.tool" ||
    !("call" in value) ||
    value.call === null ||
    typeof value.call !== "object" ||
    Array.isArray(value.call)
  )
    return undefined;
  return value as unknown as ToolDisplay;
}

export function displayTool<T extends TSchema, D extends JsonValue>(
  tool: ToolRegistration<T, D>,
  describe: (args: Static<T>) => ToolCallDetails,
): ToolRegistration<T> {
  descriptions.set(tool.parameters, (args) => {
    try {
      const validated = validateToolArguments(tool, {
        type: "toolCall",
        id: "display",
        name: tool.name,
        arguments: args,
      }) as Static<T>;
      return describe(validated);
    } catch {
      return undefined;
    }
  });
  return {
    ...tool,
    async execute(args, api, context) {
      const call = describe(args);
      let result: JsonValue | undefined;
      await api.details({ kind: "vidhan-bot.tool", call }, context);
      const response = await tool.execute(
        args,
        {
          ...api,
          details: async (value, updateContext) => {
            result = value;
            await api.details({ kind: "vidhan-bot.tool", call, result }, updateContext);
          },
        },
        context,
      );
      if (response.details !== undefined) result = response.details;
      return {
        ...response,
        details: { kind: "vidhan-bot.tool", call, ...(result === undefined ? {} : { result }) },
      };
    },
  };
}
