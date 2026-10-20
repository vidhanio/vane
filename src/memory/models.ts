import {
  createAssistantMessageEventStream,
  type Message,
  type Models,
  type Usage,
} from "@earendil-works/pi-ai";
import { cacheKeys, cachePayload, CacheGate, type Flight } from "./cache.ts";

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
      let flight: Flight = { begun: noop, end: noop };
      try {
        const messages = settings.project
          ? await settings.project(input.messages, options?.signal)
          : input.messages;
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
                    if (selected.api !== "anthropic-messages") return transformed;
                    const cached = cachePayload(transformed);
                    flight.end();
                    flight = await gate.enter(
                      cacheKeys(cached, `${selected.provider}/${selected.baseUrl}`),
                      options?.signal,
                    );
                    return cached;
                  },
                  onProviderStreamEvent: async (event, selected) => {
                    if (
                      selected.api === "anthropic-messages" &&
                      typeof event === "object" &&
                      event !== null &&
                      "type" in event &&
                      event.type === "message_start"
                    )
                      flight.begun();
                    await options?.onProviderStreamEvent?.(event, selected);
                  },
                }
              : {}),
          },
        );
        for await (const event of stream) {
          if (event.type !== "start" && event.type !== "error") flight.begun();
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
        flight.end();
      }
    })();
    return output;
  };
  return wrapped;
}
