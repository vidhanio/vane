import {
  createAssistantMessageEventStream,
  getCurrentSystemMessage,
  type Message,
  type Models,
  type Usage,
} from "@earendil-works/pi-ai";
import { cachePayload, CacheGate } from "./cache.ts";

const noop = () => {};

export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function requestModels(
  models: Models,
  settings: {
    project?: (messages: readonly Message[], signal?: AbortSignal) => Promise<readonly Message[]>;
    cache?: boolean;
  },
): Models {
  const gate = new CacheGate();
  const wrapped = Object.create(models) as Models;
  wrapped.streamSimple = (model, input, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let release = noop;
      try {
        const messages = settings.project
          ? await settings.project(input.messages, options?.signal)
          : input.messages;
        if (settings.cache && model.api === "anthropic-messages") {
          const prompt = getCurrentSystemMessage(messages);
          const view = messages.find(
            (message) =>
              message.role === "user" &&
              Array.isArray(message.content) &&
              message.content.some(
                (block) => block.type === "text" && block.text.startsWith("<chat>\n"),
              ),
          );
          const blocks = view?.role === "user" && Array.isArray(view.content) ? view.content : [];
          const text = blocks.find((block) => block.type === "text")?.text ?? "";
          const lines = text.split("\n");
          const whole = lines
            .slice(0, Math.max(0, Math.floor((lines.length - 2) / 4) * 4 + 1))
            .join("\n");
          release = await gate.enter(
            `${model.provider}/${model.id}/${options?.reasoning ?? "off"}/${JSON.stringify(prompt)}\n${whole}`,
            options?.signal,
          );
        }
        const stream = models.streamSimple(
          model,
          { ...input, messages: [...messages] },
          {
            ...options,
            ...(settings.cache
              ? {
                  cacheRetention: "short",
                  transport: "sse",
                  onPayload: async (payload, selected) => {
                    const transformed = (await options?.onPayload?.(payload, selected)) ?? payload;
                    return selected.api === "anthropic-messages"
                      ? cachePayload(transformed)
                      : transformed;
                  },
                }
              : {}),
          },
        );
        for await (const event of stream) {
          if (event.type !== "start") release();
          output.push(event);
        }
        output.end(await stream.result());
      } catch (error) {
        const reason = options?.signal?.aborted ? "aborted" : "error";
        output.push({
          type: "error",
          reason,
          error: {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: zeroUsage(),
            stopReason: reason,
            errorMessage: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        });
      } finally {
        release();
      }
    })();
    return output;
  };
  return wrapped;
}
