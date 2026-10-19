import {
  LiveDoc,
  UsageDoc,
  type Agent,
  type ConversationView,
  type LiveState,
  type UsageState,
} from "@earendil-works/pi-durable";
import { codeBlock, Colors, EmbedBuilder, escapeCodeBlock, inlineCode, subtext } from "discord.js";
import { stripVTControlCharacters } from "node:util";
import type { ToolActivity } from "../index.ts";

function inline(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return inlineCode(
    stripVTControlCharacters(text)
      .replace(/[\p{Cc}\p{Cf}`]/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500)
      .toWellFormed(),
  );
}

export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return `ERROR:\n${codeBlock(escapeCodeBlock(stripVTControlCharacters(text).toWellFormed()))}`;
}

export function toolText(call: ToolActivity): string {
  const args = call.arguments;
  let text: string;
  switch (call.name) {
    case "read":
      text = `reading ${inline(args.path)}`;
      break;
    case "edit":
      text = `editing ${inline(args.path)}`;
      break;
    case "write":
      text = `writing ${inline(args.path)}`;
      break;
    case "bash":
      text = `running ${inline(args.command)}`;
      break;
    case "agent_create":
      text = `creating agent ${inline(args.name)} at ${inline(args.path)}`;
      break;
    case "agent_status":
      text = args.id === undefined ? "checking agents" : `checking agent ${inline(args.id)}`;
      break;
    case "agent_delete":
      text = `deleting agent ${inline(args.id)}`;
      break;
    case "agent_delegate":
      text = `delegating to agent ${inline(args.id)}`;
      break;
    case "agent_subscribe":
      text = `subscribing to agent ${inline(args.id)}`;
      break;
    default:
      text = `using ${inline(call.name)}`;
  }
  return subtext(text);
}

export function conversationEmbed(agent: Agent, view: ConversationView): EmbedBuilder {
  const live = view.docs[LiveDoc.definition.kind] as LiveState | undefined;
  const usage = view.docs[UsageDoc.definition.kind] as UsageState | undefined;
  const running = live?.tools?.findLast((tool) => tool.status === "running");
  const activity = !live?.run
    ? "idle"
    : running
      ? `using ${running.name}`
      : live.generation
        ? "thinking"
        : "working";
  let tokens = 0;
  let cost = 0;
  for (const bucket of [usage?.models, usage?.tools])
    for (const entry of Object.values(bucket ?? {})) {
      tokens += entry.totalTokens;
      cost += entry.cost.total;
    }
  return new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("Shared session status")
    .addFields(
      { name: "Status", value: activity, inline: true },
      {
        name: "Model",
        value: agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "Not configured",
        inline: true,
      },
      { name: "Thinking", value: agent.thinkingLevel, inline: true },
      {
        name: "Usage",
        value: `${tokens.toLocaleString("en-US")} tokens · $${cost.toFixed(4)}`,
        inline: true,
      },
      { name: "Directory", value: inline(agent.cwd ?? "Not configured"), inline: false },
    );
}
