import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { Mutex } from "async-mutex";
import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { pathSchema, type BotConfig } from "./config.ts";
import { content } from "./content.ts";
import { HerdrClient, HerdrError } from "./herdr-client.ts";

const strict = { additionalProperties: false };
const target = Type.String({ minLength: 1, description: "Live agent name or pane ID." });
const agentSchema = z.object({
  terminal_id: z.string(),
  pane_id: z.string(),
  workspace_id: z.string(),
  name: z.string().nullish().default(null),
  agent: z.string().nullish().default(null),
  title: z.string().nullish().default(null),
  terminal_title_stripped: z.string().nullish().default(null),
  agent_status: z.enum(["idle", "done", "working", "blocked", "unknown"]),
  interactive_ready: z.boolean().default(false),
  launch_pending: z.boolean().default(false),
  cwd: z.string().nullish().default(null),
});
type Agent = z.infer<typeof agentSchema>;
const agentResult = z.object({ agent: agentSchema });
const waitTimeout = 30 * 60_000;

async function get(
  client: HerdrClient,
  name: string,
  context: Context,
  timeout = 35_000,
): Promise<Agent> {
  return agentResult.parse(await client.request("agent.get", { target: name }, context, timeout))
    .agent;
}

async function report(client: HerdrClient, agent: Agent, context: Context) {
  try {
    const source =
      agent.agent_status === "idle" || agent.agent_status === "done"
        ? "recent_unwrapped"
        : "visible";
    const { read } = z
      .object({ read: z.object({ text: z.string(), truncated: z.boolean() }) })
      .parse(
        await client.request(
          "agent.read",
          {
            target: agent.pane_id,
            source,
            lines: 200,
          },
          context,
        ),
      );
    return { agent, report: read.text, truncated: read.truncated };
  } catch (error) {
    context.abortSignal?.throwIfAborted();
    return {
      agent,
      report: "",
      read_error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function start(
  client: HerdrClient,
  paneId: string,
  name: string,
  kind: "pi" | "claude" | "codex",
  context: Context,
) {
  const launched = agentResult.parse(
    await client.request(
      "agent.start",
      {
        name,
        kind,
        pane_id: paneId,
        timeout_ms: 30_000,
      },
      context,
    ),
  ).agent;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = await get(client, paneId, context, Math.max(1, deadline - Date.now()));
    if (current.terminal_id !== launched.terminal_id || current.name !== name)
      throw new Error("Worker identity changed during startup");
    if (current.agent && current.agent !== kind)
      throw new Error(`Expected ${kind}, detected ${current.agent}`);
    if (
      current.agent_status === "blocked" ||
      (current.interactive_ready &&
        (current.agent_status === "idle" ||
          current.agent_status === "done" ||
          (kind === "codex" && current.agent_status === "unknown")))
    ) {
      const result = await report(client, current, context);
      if (current.agent_status === "blocked")
        throw new HerdrError(
          "agent_not_ready",
          `Agent ${name} is blocked during startup; ask the user before sending input`,
        );
      return result;
    }
    if (
      (current.agent_status === "idle" || current.agent_status === "done") &&
      !current.launch_pending &&
      !current.interactive_ready
    )
      throw new HerdrError("agent_start_failed", "Worker exited before becoming interactive");
    await delay(Math.min(200, Math.max(0, deadline - Date.now())), undefined, {
      signal: context.abortSignal,
    });
  }
  throw new HerdrError("timeout", `Agent ${name} did not become interactive within 30 seconds`);
}

export function agentTools(config: BotConfig) {
  const client = new HerdrClient(config.herdr_socket);
  const locks = new Map<string, Mutex>();
  const mutex = (pane: string) => {
    let value = locks.get(pane);
    if (!value) {
      value = new Mutex();
      locks.set(pane, value);
    }
    return value;
  };
  return [
    defineTool({
      name: "herdr_list",
      description: "List Herdr workspaces and live agents to find an existing workspace or worker.",
      parameters: Type.Object({}, strict),
      execute: async (_args, _api, context) => {
        const [workspaceResult, agentList] = await Promise.all([
          client.request("workspace.list", {}, context),
          client.request("agent.list", {}, context),
        ]);
        const { workspaces } = z
          .object({
            workspaces: z.array(z.looseObject({ workspace_id: z.string(), label: z.string() })),
          })
          .parse(workspaceResult);
        const { agents } = z.object({ agents: z.array(agentSchema) }).parse(agentList);
        return { output: content({ workspaces, agents }) };
      },
    }),
    defineTool({
      name: "herdr_create_workspace",
      description:
        "Open a Herdr workspace at an existing project directory without changing focus.",
      parameters: Type.Object(
        {
          project: Type.String({ minLength: 1, pattern: "^(?:/|~/)" }),
          name: Type.String({ minLength: 1 }),
        },
        strict,
      ),
      execute: async (args, _api, context) => {
        const project = pathSchema.parse(args.project);
        if (!(await stat(project)).isDirectory())
          throw new Error("Project must be an existing directory");
        return {
          output: content(
            await client.request(
              "workspace.create",
              { cwd: project, label: args.name, focus: false },
              context,
            ),
          ),
        };
      },
    }),
    defineTool({
      name: "herdr_create_agent",
      description:
        "Start a named agent in a new tab in an existing Herdr workspace without changing focus. Uses the workspace's working directory and defaults to pi. Returns when the agent is ready; ask the user about startup blockers before sending input.",
      parameters: Type.Object(
        {
          workspace: Type.String({ minLength: 1 }),
          name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" }),
          kind: Type.Optional(
            Type.Union([Type.Literal("pi"), Type.Literal("claude"), Type.Literal("codex")]),
          ),
        },
        strict,
      ),
      execute: async (args, api, context) => {
        const { panes } = z
          .object({
            panes: z.array(z.object({ cwd: z.string().nullish(), focused: z.boolean() })),
          })
          .parse(await client.request("pane.list", { workspace_id: args.workspace }, context));
        const cwd =
          panes.find((pane) => pane.focused && pane.cwd)?.cwd ??
          panes.find((pane) => pane.cwd)?.cwd;
        if (!cwd) throw new Error("Workspace has no pane with a working directory");
        const tab = z
          .object({ root_pane: z.object({ pane_id: z.string() }) })
          .parse(
            await client.request(
              "tab.create",
              { workspace_id: args.workspace, cwd, label: args.name, focus: false },
              context,
            ),
          );
        api.output(`Starting ${args.name} in ${args.workspace}…\n`);
        try {
          return {
            output: content(
              await start(client, tab.root_pane.pane_id, args.name, args.kind ?? "pi", context),
            ),
          };
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          throw new Error(
            `Agent startup at ${tab.root_pane.pane_id} failed; check existing work before retrying. ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      },
    }),
    defineTool({
      name: "herdr_read",
      description:
        "Read a Herdr agent's current status and terminal output without sending input. Use to check existing work, blockers, or uncertain submissions before considering another delegation.",
      parameters: Type.Object({ agent: target }, strict),
      execute: async (args, _api, context) => ({
        output: content(await report(client, await get(client, args.agent, context), context)),
      }),
    }),
    defineTool({
      name: "herdr_delegate",
      description:
        "Send a task to an idle Herdr agent and wait up to 30 minutes for Herdr to report completion or a blocker, then return status and terminal output. Pass the user's request directly, adding only relevant prior context or adjusting tense and references. Do not inspect the project, investigate, plan the implementation, or expand the task into detailed instructions yourself; let the agent figure it out. Busy, blocked, or unknown agents receive no input. Uncertain submissions are never automatically retried.",
      parameters: Type.Object(
        { agent: target, task: Type.String({ minLength: 1, maxLength: 100_000 }) },
        strict,
      ),
      execute: async (args, api, context) => {
        const agent = await get(client, args.agent, context);
        return mutex(agent.pane_id).runExclusive(async () => {
          context.abortSignal?.throwIfAborted();
          const current = await get(client, agent.pane_id, context);
          if (current.terminal_id !== agent.terminal_id)
            throw new Error("Worker was replaced before delegation");
          if (current.agent_status !== "idle" && current.agent_status !== "done") {
            const final = await report(client, current, context);
            const reason =
              "Worker is busy, blocked or unknown. No text was sent; ask the user if needed.";
            return { output: content({ ...final, submitted: false, reason }) };
          }
          api.output(`Delegating to ${current.name ?? current.pane_id}…\n`);
          try {
            const result = await client.request(
              "agent.prompt",
              { target: current.pane_id, text: args.task, wait: { timeout_ms: waitTimeout } },
              context,
              waitTimeout + 5000,
            );
            const final = await report(client, agentResult.parse(result).agent, context);
            return { output: content({ ...final, submitted: true }) };
          } catch (error) {
            context.abortSignal?.throwIfAborted();
            const final = await report(
              client,
              await get(client, current.pane_id, context),
              context,
            );
            const message = error instanceof Error ? error.message : String(error);
            return {
              output: content({
                ...final,
                submitted: "uncertain",
                timed_out: error instanceof HerdrError && error.code === "timeout",
                error: message,
                note: "Check existing work before resending. The text was not automatically retried.",
              }),
            };
          }
        });
      },
    }),
  ];
}
