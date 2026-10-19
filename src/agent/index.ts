import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import { defineTool, type AnyTask, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { content } from "../content.ts";

type AgentResult = { ok: boolean; [key: string]: unknown };
export interface AgentBackend {
  tasks: readonly AnyTask[];
  create(
    args: { path: string; name: string },
    api: ToolExecutionApi,
    context: Context,
  ): Promise<AgentResult>;
  status(args: { id?: string }, api: ToolExecutionApi, context: Context): Promise<AgentResult>;
  delegate(
    args: { id: string; prompt: string },
    api: ToolExecutionApi,
    context: Context,
  ): Promise<AgentResult>;
  subscribe(args: { id: string }, api: ToolExecutionApi, context: Context): Promise<AgentResult>;
  delete(args: { id: string }, api: ToolExecutionApi, context: Context): Promise<AgentResult>;
}

const strict = { additionalProperties: false };
const agentId = Type.String({
  minLength: 1,
  description: "Agent id returned by agent_create or agent_status.",
});
const render = (value: { ok: boolean; [key: string]: unknown }) => ({
  output: content(value),
  ...(!value.ok ? { isError: true } : {}),
});

export function agentIntegration(backend: AgentBackend) {
  return {
    tasks: backend.tasks,
    tools: [
      defineTool({
        name: "agent_create",
        description:
          "Start a named agent in an existing project directory without changing focus. Return its id and initial status/output snapshot; no task is sent.",
        parameters: Type.Object(
          {
            path: Type.String({
              minLength: 1,
              pattern: "^(?:/|~/)",
              description: "Existing project directory, as an absolute path or ~/ path.",
            }),
            name: Type.String({
              pattern: "^[a-z][a-z0-9_-]{0,31}$",
              description:
                "Unique agent name: a lowercase letter followed by up to 31 lowercase letters, digits, underscores or hyphens.",
            }),
          },
          strict,
        ),
        execute: async (args, api, context) => render(await backend.create(args, api, context)),
      }),
      defineTool({
        name: "agent_status",
        description:
          "Return an agent's current status and terminal snapshot without sending input. Omit id for an overview of all live agents. A snapshot is terminal output, not the agent's full chat; idle or done does not prove task success.",
        parameters: Type.Object({ id: Type.Optional(agentId) }, strict),
        execute: async (args, api, context) => render(await backend.status(args, api, context)),
      }),
      defineTool({
        name: "agent_delegate",
        description:
          "Send a task or correction and return after submission, not completion. Automatically subscribe to updates. Input sent while working is steering, not a queued after-task request. Pass the user's request and relevant context; let the agent investigate. Blocked or unknown agents receive no input. If submission is uncertain, inspect agent_status before resending; prompts are never automatically resent.",
        parameters: Type.Object(
          {
            id: agentId,
            prompt: Type.String({
              minLength: 1,
              maxLength: 100_000,
              description: "Task, follow-up or correction to send.",
            }),
          },
          strict,
        ),
        execute: async (args, api, context) => render(await backend.delegate(args, api, context)),
      }),
      defineTool({
        name: "agent_subscribe",
        description:
          "Watch an agent's current work once. Return immediately; a report arrives as a message when the agent settles, blocks or becomes unavailable, or monitoring fails. Already idle or done agents report their current snapshot. Subscriptions survive restarts and track agent state, not completion of a particular prompt. Keep working or end the turn rather than waiting or polling.",
        parameters: Type.Object({ id: agentId }, strict),
        execute: async (args, api, context) => render(await backend.subscribe(args, api, context)),
      }),
      defineTool({
        name: "agent_delete",
        description:
          "Close the agent's terminal and terminate its running processes after user authorization. Project files and worktrees are not deleted. If deletion is uncertain, inspect agent_status before retrying.",
        parameters: Type.Object({ id: agentId }, strict),
        execute: async (args, api, context) => render(await backend.delete(args, api, context)),
      }),
    ],
  };
}
