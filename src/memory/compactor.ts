import {
  clampThinkingLevel,
  type Message,
  type Models,
  type ModelThinkingLevel,
  type SystemMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import type { Compressor } from "./index.ts";
import { bytes, end, start } from "./view.ts";

export type CompactorChoice = { provider: string; model_id: string; thinking: ModelThinkingLevel };

export function createCompressor(
  models: Models,
  choice: CompactorChoice,
  system: (signal: AbortSignal) => Promise<SystemMessage>,
  onUsage: (usage: Usage) => Promise<void>,
  sessionId: string,
): Compressor {
  return async ({ part, source, view }, signal) => {
    const prompt = await system(signal);
    const model = models.getModel(choice.provider, choice.model_id);
    if (!model) throw new Error(`Unknown compactor ${choice.provider}/${choice.model_id}`);
    const id = start(part);
    const ruler = "-".repeat(512);
    const task =
      part[0] === 0
        ? `Compaction: compress message ${id} into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n${ruler}\n<input>\n${source}\n</input>`
        : `Compaction: merge lines ${id}+${2 ** (part[0] - 1)} and ${id + 2 ** (part[0] - 1)}+${2 ** (part[0] - 1)}, adjacent, into one line of at most\n512 bytes (about 70 words), the length of this ruler:\n${ruler}\n<chat> may hold their messages, ${id} to ${end(part) - 1}, in more detail: take details\nof them from there too.\n<input>\n${source}\n</input>`;
    const messages: Message[] = [
      prompt,
      {
        role: "user",
        content: [
          { type: "text", text: view },
          { type: "text", text: `\n\n${task}` },
        ],
        timestamp: 0,
      },
    ];
    let shortest: string | undefined;
    const thinking = clampThinkingLevel(model, choice.thinking);
    for (let attempt = 0; attempt < 5; attempt++) {
      const reply = await models
        .streamSimple(
          model,
          { messages },
          {
            signal,
            sessionId,
            cacheRetention: "short",
            transport: "sse",
            ...(thinking === "off" ? {} : { reasoning: thinking }),
          },
        )
        .result();
      await onUsage(reply.usage);
      if (reply.stopReason === "error" || reply.stopReason === "aborted")
        throw new Error(reply.errorMessage ?? `Compactor ${reply.stopReason}`);
      if (reply.stopReason === "length" || reply.content.some((block) => block.type === "toolCall"))
        continue;
      const text = reply.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim()
        .replace(/^\d+\+\d+\|\s*/, "");
      if (!text) throw new Error("Compactor returned no summary");
      if (shortest === undefined || bytes(text) < bytes(shortest)) shortest = text;
      if (bytes(text) <= 512) return text;
      messages.push(reply);
      const cut = Buffer.from(text)
        .subarray(0, 512)
        .toString("utf8")
        .replace(/\uFFFD$/, "");
      messages.push({
        role: "user",
        content: `Too long: your line is ${bytes(text)} bytes, over the 512-byte limit. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\n${cut}| ← LIMIT`,
        timestamp: 0,
      });
    }
    if (!shortest) throw new Error("Compactor returned no whole line in five attempts");
    return shortest;
  };
}
