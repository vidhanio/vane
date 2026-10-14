import type { Context } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { Mutex } from "async-mutex";
import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { pathSchema, type BotConfig } from "./config.ts";
import { content } from "./content.ts";
import { HerdrClient, HerdrError } from "./herdr-client.ts";

const strict = { additionalProperties: false };
const target = Type.String();
const agentSchema = z.object({
  terminal_id: z.string(),
  pane_id: z.string(),
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
export const herdrProgressSchema = z.object({
  agents: z.array(agentSchema),
  report: z.string(),
  truncated: z.boolean(),
  note: z.string(),
});
const agentResult = z.object({ agent: agentSchema });
const waitTimeout = 30 * 60_000;

async function get(client: HerdrClient, name: string, context: Context): Promise<Agent> {
  return agentResult.parse(await client.request("agent.get", { target: name }, context)).agent;
}

async function report(client: HerdrClient, agent: Agent, context: Context) {
  try {
    const source =
      agent.agent_status === "idle" || agent.agent_status === "done"
        ? "recent_unwrapped"
        : "visible";
    const read = z.object({ text: z.string(), truncated: z.boolean() }).parse(
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

async function publishReport(
  api: ToolExecutionApi,
  result: Awaited<ReturnType<typeof report>>,
  context: Context,
  note = "",
) {
  await api.details(
    {
      agents: [result.agent],
      report: result.report,
      truncated: "truncated" in result ? result.truncated : false,
      note: note || ("read_error" in result ? result.read_error : ""),
    },
    context,
  );
}

async function withProgress<T>(
  client: HerdrClient,
  agent: Agent,
  api: ToolExecutionApi,
  context: Context,
  work: () => Promise<T>,
): Promise<T> {
  const child = withCancel(context);
  const updates = (async () => {
    const events = client.watchAgent(agent.pane_id, child.context, waitTimeout + 5000);
    let lastUpdate = 0;
    try {
      while (!(await events.next()).done) {
        await delay(Math.max(0, 1000 - (Date.now() - lastUpdate)), undefined, {
          signal: child.context.abortSignal,
        });
        const current = await get(client, agent.pane_id, child.context);
        if (current.terminal_id !== agent.terminal_id)
          throw new Error("Worker replaced while streaming progress");
        await publishReport(api, await report(client, current, child.context), child.context);
        lastUpdate = Date.now();
      }
    } catch (error) {
      if (!child.context.abortSignal?.aborted)
        console.error("Herdr progress stream failed", { paneId: agent.pane_id, error });
    } finally {
      await events.return(undefined);
    }
  })();
  try {
    return await work();
  } finally {
    child.cancel();
    await updates;
  }
}

async function start(
  client: HerdrClient,
  paneId: string,
  name: string,
  kind: "pi" | "claude" | "codex",
  api: ToolExecutionApi,
  context: Context,
) {
  const events = client.watchAgent(paneId, context);
  try {
    await events.next();
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
    while (true) {
      const current = await get(client, name, context);
      if (current.terminal_id !== launched.terminal_id || current.name !== name)
        throw new Error("Worker was replaced during startup");
      const result = await report(client, current, context);
      await publishReport(api, result, context);
      if (
        current.agent_status === "blocked" ||
        current.interactive_ready ||
        !current.launch_pending
      )
        return result;
      await events.next();
    }
  } finally {
    await events.return(undefined);
  }
}

export function agentTool(config: BotConfig) {
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
  return defineTool({
    name: "herdr",
    description:
      "Delegate work to visible Herdr subagents over the socket. list discovers subagents; start opens a project and starts pi, claude or codex; inspect reads a subagent's status and output. delegate sends one task and listens for completion or a blocker, then returns its report. wait listens without sending another task. Each wait is capped at 30 minutes; blocked/unknown state needs human attention. This tool does not run raw commands or approve anything on the subagent's behalf.",
    parameters: Type.Union(
      [
        Type.Object({ action: Type.Literal("list") }, strict),
        Type.Object(
          {
            action: Type.Literal("start"),
            project: Type.String({ minLength: 1, pattern: "^(?:/|~/)" }),
            name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" }),
            kind: Type.Optional(
              Type.Union([Type.Literal("pi"), Type.Literal("claude"), Type.Literal("codex")]),
            ),
          },
          strict,
        ),
        Type.Object({ action: Type.Literal("inspect"), agent: target }, strict),
        Type.Object(
          {
            action: Type.Literal("delegate"),
            agent: target,
            task: Type.String({ minLength: 1, maxLength: 100_000 }),
          },
          strict,
        ),
        Type.Object({ action: Type.Literal("wait"), agent: target }, strict),
      ],
      { type: "object" },
    ),
    execute: async (args, api, context) => {
      if (args.action === "list") {
        const result = z
          .object({ agents: z.array(agentSchema) })
          .parse(await client.request("agent.list", {}, context));
        await api.details({ ...result, report: "", truncated: false, note: "" }, context);
        return { output: content(result) };
      }
      if (args.action === "start") {
        const project = pathSchema.parse(args.project);
        if (!(await stat(project)).isDirectory())
          throw new Error("Project must be an existing directory");
        const workspace = z.object({ root_pane: z.object({ pane_id: z.string() }) }).parse(
          await client.request(
            "workspace.create",
            {
              cwd: project,
              label: args.name,
              focus: false,
            },
            context,
          ),
        );
        api.output(`Starting ${args.name} in ${project}…\n`);
        try {
          return {
            output: content(
              await start(
                client,
                workspace.root_pane.pane_id,
                args.name,
                args.kind ?? "pi",
                api,
                context,
              ),
            ),
          };
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          throw new Error(
            `Workspace opened at ${workspace.root_pane.pane_id}; inspect ${args.name} before retrying startup. ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
      const agent = await get(client, args.agent, context);
      const initial = await report(client, agent, context);
      await publishReport(api, initial, context);
      if (args.action === "inspect") return { output: content(initial) };
      return mutex(agent.pane_id).runExclusive(async () => {
        context.abortSignal?.throwIfAborted();
        const current = await get(client, agent.pane_id, context);
        if (current.terminal_id !== agent.terminal_id)
          throw new Error("Worker was replaced before delegation");
        if (
          args.action === "delegate" &&
          current.agent_status !== "idle" &&
          current.agent_status !== "done"
        ) {
          const final = await report(client, current, context);
          const reason =
            "Worker is busy, blocked or unknown. Wait or ask the user; no task was sent.";
          await publishReport(api, final, context, reason);
          return { output: content({ ...final, submitted: false, reason }) };
        }
        api.output(
          `${args.action === "delegate" ? "Delegating to" : "Waiting for"} ${current.name ?? current.pane_id}…\n`,
        );
        try {
          const result = await withProgress(client, current, api, context, () =>
            args.action === "delegate"
              ? client.request(
                  "agent.prompt",
                  { target: current.pane_id, text: args.task, wait: { timeout_ms: waitTimeout } },
                  context,
                  waitTimeout + 5000,
                )
              : client.request(
                  "agent.wait",
                  { target: current.pane_id, timeout_ms: waitTimeout },
                  context,
                  waitTimeout + 5000,
                ),
          );
          const final = await report(client, agentResult.parse(result).agent, context);
          await publishReport(api, final, context);
          return { output: content({ ...final, submitted: args.action === "delegate" }) };
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          const final = await report(client, await get(client, current.pane_id, context), context);
          const message = error instanceof Error ? error.message : String(error);
          await publishReport(api, final, context, message);
          return {
            output: content({
              ...final,
              submitted: args.action === "delegate" ? "uncertain" : false,
              timed_out: error instanceof HerdrError && error.code === "timeout",
              error: message,
              note: "Inspect existing work before resending. The task was not automatically retried.",
            }),
          };
        }
      });
    },
  });
}
