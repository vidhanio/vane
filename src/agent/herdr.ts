import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  defineTask,
  type ConversationId,
  type EntryId,
  type TaskId,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import { Mutex } from "async-mutex";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { pathSchema, type BotConfig } from "../config.ts";
import { AgentNotification, DirectMessage } from "../messages.ts";
import type { AgentBackend } from "./index.ts";
import { HerdrClient, HerdrError } from "./herdr-client.ts";

const agentSchema = z.object({
  terminal_id: z.string(),
  pane_id: z.string(),
  name: z.string().optional(),
  agent: z.string().optional(),
  agent_session: z.object({ agent: z.string(), kind: z.string(), value: z.string() }).optional(),
  agent_status: z.enum(["idle", "done", "working", "blocked", "unknown"]),
  interactive_ready: z.boolean().default(false),
  launch_pending: z.boolean().default(false),
  cwd: z.string().optional(),
  state_change_seq: z.number(),
  completion_seq: z.number().optional(),
});
type Agent = z.infer<typeof agentSchema>;
type Binding = {
  terminal: string;
  pane: string;
  kind?: string;
  session?: string;
  retired?: boolean;
};
type Effect = "not_applied" | "applied" | "uncertain" | "none";
export type AgentError = {
  operation: string;
  code: string;
  detail: string;
  effect: Effect;
  message: string;
};

function failure(operation: string, code: string, detail: string, effect: Effect): AgentError {
  return {
    operation,
    code,
    detail,
    effect,
    message: `Agent ${operation} failed [${code}]: ${detail} (effect: ${effect}).`,
  };
}
class AgentFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function normalize(operation: string, error: unknown, effect: Effect): AgentError {
  if (error instanceof AgentFailure) return failure(operation, error.code, error.message, effect);
  const code = error instanceof HerdrError ? error.code : undefined;
  if (code && ["agent_not_found", "pane_not_found", "terminal_not_found"].includes(code))
    return failure(operation, "not_found", "Agent is no longer available", effect);
  if (code === "agent_blocked")
    return failure(operation, "blocked", "Agent requires interactive input", effect);
  if (code === "timeout")
    return failure(operation, "timeout", "Agent service did not respond in time", effect);
  return failure(operation, "service_error", "Agent service request failed", effect);
}
const result = (value: { ok: boolean; [key: string]: unknown }) => value;
const Bindings = defineDoc<{ agents: Record<string, Binding> }>({
  kind: "vane.agents",
  version: 1,
  scope: "session",
  initial: () => ({ agents: {} }),
});
const Subscriptions = defineDoc<{ agents: Record<string, TaskId<null>> }>({
  kind: "vane.agents.subscriptions",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ agents: {} }),
});
const WatchControl = defineDoc<{
  armed: boolean;
  cancelled: boolean;
  deleted: boolean;
  deleting: boolean;
}>({
  kind: "vane.agents.watch.control",
  version: 1,
  scope: "task",
  initial: () => ({ armed: true, cancelled: false, deleted: false, deleting: false }),
});
type WatchInput = {
  id: string;
  name: string;
  baseline: number;
  requireStart: boolean;
  startedAt: number;
  origin: EntryId;
  key: string;
};
type Snapshot = {
  id: string;
  name: string | null;
  path: string | null;
  status: Agent["agent_status"];
  ready: boolean;
  output: { text: string; source: "visible" | "recent"; truncated: boolean; error?: AgentError };
};
type Report = {
  id: string;
  event:
    | "settled"
    | "blocked"
    | "unavailable"
    | "replaced"
    | "start_unobserved"
    | "monitor_error"
    | "deleted";
  snapshot?: Snapshot;
  error?: AgentError;
};
type WatchState =
  | { phase: "watch"; seenWorking: boolean; errors: number; polls: number }
  | { phase: "notify"; report: Report };
const sessionIdentity = (agent: Agent) =>
  agent.agent_session ? JSON.stringify(agent.agent_session) : undefined;
function matches(binding: Binding, agent: Agent): boolean {
  return (
    binding.terminal === agent.terminal_id &&
    (!binding.kind || !agent.agent || binding.kind === agent.agent) &&
    (!binding.session || !agent.agent_session || binding.session === sessionIdentity(agent))
  );
}
function summary(id: string, agent: Agent) {
  return {
    id,
    name: agent.name ?? null,
    path: agent.cwd ?? null,
    status: agent.agent_status,
    ready: agent.interactive_ready,
  };
}
async function bindingFor(tx: Tx, id: string): Promise<Binding> {
  if (!/^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
    throw new AgentFailure("invalid_id", "Malformed agent id");
  const binding = (await tx.doc(Bindings)).agents[id];
  if (!binding) throw new AgentFailure("not_found", "Agent id is not known");
  return { ...binding };
}
async function observe(tx: Tx, agent: Agent): Promise<string> {
  const bindings = await tx.doc(Bindings);
  for (const [id, binding] of Object.entries(bindings.agents)) {
    if (binding.retired || binding.terminal !== agent.terminal_id) continue;
    if (!matches(binding, agent)) {
      binding.retired = true;
      continue;
    }
    binding.pane = agent.pane_id;
    if (agent.agent) binding.kind = agent.agent;
    const session = sessionIdentity(agent);
    if (session) binding.session = session;
    return id;
  }
  const id = `agent_${randomUUID()}`;
  const session = sessionIdentity(agent);
  bindings.agents[id] = {
    terminal: agent.terminal_id,
    pane: agent.pane_id,
    ...(agent.agent ? { kind: agent.agent } : {}),
    ...(session ? { session } : {}),
  };
  return id;
}
async function removeSubscription(
  tx: Tx,
  conversation: ConversationId,
  input: WatchInput,
  task: TaskId<null>,
) {
  const subscriptions = await tx.doc(Subscriptions, conversation);
  if (subscriptions.agents[input.key] === task) delete subscriptions.agents[input.key];
}

export function herdrBackend(config: BotConfig): AgentBackend {
  const socket =
    config.agent_socket ??
    process.env.HERDR_SOCKET_PATH ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "herdr",
      ...(process.env.HERDR_SESSION ? ["sessions", process.env.HERDR_SESSION] : []),
      "herdr.sock",
    );
  const client = new HerdrClient(socket);
  const locks = new Map<string, Mutex>();
  const exclusive = async <T>(key: string, action: () => Promise<T>): Promise<T> => {
    let lock = locks.get(key);
    if (!lock) {
      lock = new Mutex();
      locks.set(key, lock);
    }
    try {
      return await lock.runExclusive(action);
    } finally {
      if (!lock.isLocked()) locks.delete(key);
    }
  };
  const get = async (target: string, context: Context, timeout = 35_000): Promise<Agent> => {
    try {
      return z
        .object({ agent: agentSchema })
        .parse(await client.request("agent.get", { target }, context, timeout)).agent;
    } catch (error) {
      if (!(error instanceof HerdrError) || error.code !== "agent_not_found") throw error;
      const { pane } = z
        .object({ pane: agentSchema.omit({ state_change_seq: true }) })
        .parse(await client.request("pane.get", { pane_id: target }, context, timeout));
      return { ...pane, state_change_seq: 0 };
    }
  };
  const resolve = async (binding: Binding, context: Context) => {
    if (binding.retired) throw new AgentFailure("replaced", "Agent identity has been replaced");
    const agent = await get(binding.pane, context);
    if (!matches(binding, agent))
      throw new AgentFailure("replaced", "Agent identity has been replaced");
    return agent;
  };
  const snapshot = async (id: string, agent: Agent, context: Context): Promise<Snapshot> => {
    const source =
      agent.agent_status === "idle" || agent.agent_status === "done" ? "recent" : "visible";
    try {
      const { read } = z
        .object({ read: z.object({ text: z.string(), truncated: z.boolean() }) })
        .parse(
          await client.request(
            "pane.read",
            {
              pane_id: agent.pane_id,
              source: source === "recent" ? "recent_unwrapped" : "visible",
              lines: 200,
            },
            context,
          ),
        );
      return { ...summary(id, agent), output: { ...read, source } };
    } catch (error) {
      context.abortSignal?.throwIfAborted();
      return {
        ...summary(id, agent),
        output: { text: "", source, truncated: false, error: normalize("read", error, "none") },
      };
    }
  };
  const Watcher = defineTask<WatchInput, WatchState, null>({
    name: "vane.agents.watch",
    version: 1,
    initial: () => ({ phase: "watch", seenWorking: false, errors: 0, polls: 0 }),
    phases: {
      watch: async (task, runtime, context) => {
        const input = task.input;
        let report: Report | undefined;
        let { seenWorking, errors, polls } = task.state.checkpoint;
        let subscription;
        try {
          const binding = await runtime.snapshot(Bindings, context);
          const bound = binding?.agents[input.id];
          if (!bound) throw new AgentFailure("not_found", "Agent id is not known");
          const initialControl = await runtime.snapshot(WatchControl, task.id, context);
          if (!initialControl?.cancelled && !initialControl?.deleted)
            subscription = await client.subscribe(bound.pane, context);
          while (!report) {
            const revision = subscription?.revision ?? 0;
            let cancelled = false;
            await exclusive(bound.terminal, async () => {
              const control = await runtime.snapshot(WatchControl, task.id, context);
              if (control?.cancelled) {
                cancelled = true;
                return;
              }
              if (control?.deleted) {
                report = { id: input.id, event: "deleted" };
                return;
              }
              if (!control?.armed && runtime.now() - input.startedAt < 35_000) return;
              const latest = (await runtime.snapshot(Bindings, context))?.agents[input.id];
              if (!latest) throw new AgentFailure("not_found", "Agent id is not known");
              const agent = await resolve(latest, context);
              await runtime.commit(async (tx) => {
                await observe(tx, agent);
              }, context);
              if (!agent.agent && !agent.launch_pending && !agent.interactive_ready) {
                report = {
                  id: input.id,
                  event: "unavailable",
                  snapshot: await snapshot(input.id, agent, context),
                  error: failure("monitor", "not_found", "Agent is no longer running", "none"),
                };
                return;
              }
              seenWorking ||= agent.agent_status === "working";
              const settled = agent.agent_status === "idle" || agent.agent_status === "done";
              if (agent.agent_status === "blocked")
                report = {
                  id: input.id,
                  event: "blocked",
                  snapshot: await snapshot(input.id, agent, context),
                };
              else if (
                settled &&
                ((agent.completion_seq ?? 0) > input.baseline || !input.requireStart || seenWorking)
              )
                report = {
                  id: input.id,
                  event: "settled",
                  snapshot: await snapshot(input.id, agent, context),
                };
              else if (
                input.requireStart &&
                !seenWorking &&
                runtime.now() - input.startedAt >= 35_000
              )
                report = {
                  id: input.id,
                  event: "start_unobserved",
                  snapshot: await snapshot(input.id, agent, context),
                  error: failure(
                    "monitor",
                    "start_unobserved",
                    "No working or completion state was observed after submission",
                    "none",
                  ),
                };
            });
            if (cancelled) {
              await runtime.commit(async (tx) => {
                await removeSubscription(tx, runtime.conversationId, input, task.id);
                return { status: "terminal", outcome: { status: "completed", result: null } };
              }, context);
              return;
            }
            if (report) break;
            await runtime.commit(
              () => ({
                status: "running",
                checkpoint: { phase: "watch", seenWorking, errors: 0, polls: ++polls },
              }),
              context,
            );
            if (subscription) await subscription.wait(revision, 1000, context);
            else await runtime.sleep(runtime.now() + 1000, context);
            errors = 0;
          }
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          const control = await runtime.snapshot(WatchControl, task.id, context);
          const normalized = normalize("monitor", error, "none");
          if (control?.deleted || (control?.deleting && normalized.code === "not_found"))
            report = { id: input.id, event: "deleted" };
          else if (normalized.code === "not_found" || normalized.code === "replaced")
            report = {
              id: input.id,
              event: normalized.code === "replaced" ? "replaced" : "unavailable",
              error: normalized,
            };
          else if (++errors >= 5)
            report = {
              id: input.id,
              event: "monitor_error",
              error: failure("monitor", "monitor_failed", normalized.detail, "none"),
            };
        } finally {
          subscription?.close();
        }
        if (!report) await runtime.sleep(runtime.now() + 1000, context);
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: report
              ? { phase: "notify", report }
              : { phase: "watch", seenWorking, errors, polls: ++polls },
          }),
          context,
        );
      },
      notify: async (task, runtime, context) => {
        const conversation = await runtime.conversation(runtime.conversationId, context);
        if (!conversation) throw new Error("Notification conversation is missing");
        const requestId = `agent-notification:${task.id}`;
        await conversation.submit(
          {
            type: "input",
            requestId,
            whenBusy: "steer",
            content: `[${task.input.name}]\n${JSON.stringify(task.state.checkpoint.report)}`,
            entry: { kind: AgentNotification.kind, data: { requestId, origin: task.input.origin } },
          },
          context,
        );
        await runtime.commit(async (tx) => {
          await removeSubscription(tx, runtime.conversationId, task.input, task.id);
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        await removeSubscription(tx, runtime.conversationId, task.input, task.id);
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });
  const subscribe = async (
    id: string,
    agent: Agent,
    requireStart: boolean,
    armed: boolean,
    api: ToolExecutionApi,
    context: Context,
  ) =>
    api.commit(async (tx) => {
      const subscriptions = await tx.doc(Subscriptions, api.conversationId);
      let origin: EntryId | undefined;
      let cursor;
      do {
        const page = await tx.scanEntries(
          { conversationId: api.conversationId, order: "descending" },
          100,
          cursor,
        );
        const input = page.items.find(
          (entry) => DirectMessage.is(entry) || AgentNotification.is(entry),
        );
        if (input) {
          origin = AgentNotification.is(input) ? input.data.origin : input.id;
          break;
        }
        cursor = page.next;
      } while (cursor);
      if (origin === undefined)
        throw new AgentFailure("missing_origin", "Cannot subscribe without a message destination");
      const source = await tx.entry(DirectMessage, origin);
      if (!source) throw new AgentFailure("missing_origin", "Message destination is unavailable");
      const key = `${id}:${source.data.platform}:${source.data.channelId}`;
      const existing = subscriptions.agents[key];
      if (existing) {
        const task = await tx.task(existing);
        const control = await tx.doc(WatchControl, existing);
        if (
          task &&
          task.state.status !== "terminal" &&
          task.state.status !== "completing" &&
          !control.cancelled
        )
          return { task: existing, created: false };
      }
      const task = await tx.createTask(
        Watcher,
        {
          id,
          name: agent.name ?? id,
          baseline: agent.state_change_seq,
          requireStart,
          startedAt: Date.now(),
          origin,
          key,
        },
        { ownership: { kind: "conversation" }, background: true },
      );
      (await tx.doc(WatchControl, task)).armed = armed;
      subscriptions.agents[key] = task;
      return { task, created: true };
    }, context);
  const safelySnapshot = async (id: string, binding: Binding, context: Context) => {
    try {
      return await snapshot(id, await resolve(binding, context), context);
    } catch {
      context.abortSignal?.throwIfAborted();
      return undefined;
    }
  };
  return {
    tasks: [Watcher],
    create: async (args: { path: string; name: string }, api: ToolExecutionApi, context: Context) =>
      exclusive("create", async () => {
        let created: false | true | "uncertain" = false;
        let id: string | undefined;
        let binding: Binding | undefined;
        try {
          let path: string;
          try {
            path = await realpath(pathSchema.parse(args.path));
            if (!(await stat(path)).isDirectory()) throw new Error("Not a directory");
          } catch {
            throw new AgentFailure("invalid_path", "Project path must be an existing directory");
          }
          const { agents } = z
            .object({ agents: z.array(agentSchema) })
            .parse(await client.request("agent.list", {}, context));
          if (agents.some((agent) => agent.name === args.name))
            throw new AgentFailure("name_in_use", "Agent name is already in use");
          created = "uncertain";
          const { root_pane } = z
            .object({ root_pane: z.object({ pane_id: z.string(), terminal_id: z.string() }) })
            .parse(
              await client.request(
                "workspace.create",
                { cwd: path, label: args.name, focus: false },
                context,
              ),
            );
          created = true;
          binding = { terminal: root_pane.terminal_id, pane: root_pane.pane_id };
          const allocated = binding;
          const allocatedId = await api.commit(async (tx) => {
            const handle = `agent_${randomUUID()}`;
            (await tx.doc(Bindings)).agents[handle] = allocated;
            return handle;
          }, context);
          id = allocatedId;
          let bound: Binding = allocated;
          const deadline = Date.now() + 30_000;
          let launched = false;
          while (!launched) {
            try {
              const { pane } = z
                .object({ pane: z.object({ terminal_id: z.string() }) })
                .parse(await client.request("pane.get", { pane_id: bound.pane }, context));
              if (pane.terminal_id !== bound.terminal)
                throw new AgentFailure("replaced", "Agent identity changed during startup");
              const agent: Agent = z
                .object({ agent: agentSchema })
                .parse(
                  await client.request(
                    "agent.start",
                    { name: args.name, kind: "pi", pane_id: bound.pane, timeout_ms: 30_000 },
                    context,
                  ),
                ).agent;
              if (agent.terminal_id !== bound.terminal)
                throw new AgentFailure("replaced", "Agent identity changed during startup");
              const session = sessionIdentity(agent);
              bound = {
                ...bound,
                ...(agent.agent ? { kind: agent.agent } : {}),
                ...(session ? { session } : {}),
              };
              binding = bound;
              await api.commit(async (tx) => {
                (await tx.doc(Bindings)).agents[allocatedId] = bound;
              }, context);
              launched = true;
            } catch (error) {
              if (
                !(error instanceof HerdrError) ||
                error.code !== "agent_pane_busy" ||
                Date.now() >= deadline
              )
                throw error;
              await delay(200, undefined, { signal: context.abortSignal });
            }
          }
          const readyDeadline = Date.now() + 30_000;
          while (true) {
            const agent = await resolve(bound, context);
            await api.commit((tx) => observe(tx, agent), context);
            if (agent.agent_status === "blocked")
              throw new AgentFailure("blocked", "Agent is blocked during startup");
            if (
              agent.interactive_ready &&
              (agent.agent_status === "idle" || agent.agent_status === "done")
            )
              return result({ ok: true, id, snapshot: await snapshot(id, agent, context) });
            if (
              (!agent.launch_pending &&
                !agent.interactive_ready &&
                (agent.agent_status === "idle" || agent.agent_status === "done")) ||
              Date.now() >= readyDeadline
            )
              throw new AgentFailure(
                "startup_failed",
                "Agent did not become interactive within the startup window",
              );
            await delay(200, undefined, { signal: context.abortSignal });
          }
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          const partial = id && binding ? await safelySnapshot(id, binding, context) : undefined;
          return result({
            ok: false,
            error: normalize(
              "create",
              error,
              created === true ? "applied" : created === "uncertain" ? "uncertain" : "not_applied",
            ),
            created,
            ...(id ? { id } : {}),
            ...(partial ? { snapshot: partial } : {}),
          });
        }
      }),
    status: async (args: { id?: string }, api: ToolExecutionApi, context: Context) => {
      try {
        const id = args.id;
        if (id !== undefined) {
          const binding = await api.commit((tx) => bindingFor(tx, id), context);
          const agent = await resolve(binding, context);
          await api.commit((tx) => observe(tx, agent), context);
          return result({
            ok: true,
            id,
            snapshot: await snapshot(id, agent, context),
          });
        }
        const { agents } = z
          .object({ agents: z.array(agentSchema) })
          .parse(await client.request("agent.list", {}, context));
        const overview = await api.commit(async (tx) => {
          const items = [];
          for (const agent of agents) items.push(summary(await observe(tx, agent), agent));
          return items;
        }, context);
        return result({ ok: true, agents: overview });
      } catch (error) {
        context.abortSignal?.throwIfAborted();
        return result({ ok: false, error: normalize("status", error, "none") });
      }
    },
    delegate: async (
      args: { id: string; prompt: string },
      api: ToolExecutionApi,
      context: Context,
    ) => {
      const state: { submitted: boolean | "uncertain"; subscribed: boolean } = {
        submitted: false,
        subscribed: false,
      };
      let binding: Binding | undefined;
      try {
        binding = await api.commit((tx) => bindingFor(tx, args.id), context);
        const bound = binding;
        return await exclusive(bound.terminal, async () => {
          const current = await resolve(bound, context);
          await api.commit((tx) => observe(tx, current), context);
          if (current.agent_status === "blocked" || current.agent_status === "unknown")
            return result({
              ok: false,
              id: args.id,
              submitted: false,
              subscribed: false,
              snapshot: await snapshot(args.id, current, context),
              error: failure(
                "delegate",
                current.agent_status === "blocked" ? "blocked" : "unknown_status",
                "Agent cannot receive input in its current state",
                "not_applied",
              ),
            });
          const watch = await subscribe(
            args.id,
            current,
            current.agent_status !== "working",
            false,
            api,
            context,
          );
          state.subscribed = true;
          try {
            const latest = await api.commit((tx) => bindingFor(tx, args.id), context);
            const target = await resolve(latest, context);
            if (target.agent_status === "blocked" || target.agent_status === "unknown")
              throw new AgentFailure(
                target.agent_status === "blocked" ? "blocked" : "unknown_status",
                "Agent cannot receive input in its current state",
              );
            state.submitted = "uncertain";
            await client.request(
              "agent.prompt",
              { target: target.pane_id, text: args.prompt },
              context,
            );
            state.submitted = true;
          } catch (error) {
            const rejected =
              state.submitted === false ||
              (error instanceof HerdrError &&
                [
                  "agent_blocked",
                  "agent_not_ready",
                  "agent_not_found",
                  "empty_agent_prompt",
                ].includes(error.code));
            state.submitted = rejected ? false : "uncertain";
            await api.commit(async (tx) => {
              const control = await tx.doc(WatchControl, watch.task);
              if (rejected && watch.created) {
                control.cancelled = true;
                state.subscribed = false;
              } else control.armed = true;
            }, context);
            context.abortSignal?.throwIfAborted();
            return result({
              ok: false,
              id: args.id,
              ...state,
              snapshot: await safelySnapshot(args.id, bound, context),
              error: failure(
                "delegate",
                rejected ? "submission_rejected" : "submission_uncertain",
                rejected
                  ? "Input was rejected before submission"
                  : "Input may have reached the agent",
                rejected ? "not_applied" : "uncertain",
              ),
            });
          }
          await api.commit(async (tx) => {
            (await tx.doc(WatchControl, watch.task)).armed = true;
          }, context);
          return result({ ok: true, id: args.id, submitted: true, subscribed: true });
        });
      } catch (error) {
        context.abortSignal?.throwIfAborted();
        return result({
          ok: false,
          id: args.id,
          submitted: state.submitted,
          subscribed: state.submitted === true ? false : state.subscribed,
          ...(binding ? { snapshot: await safelySnapshot(args.id, binding, context) } : {}),
          error: normalize(
            "delegate",
            error,
            state.submitted === true
              ? "applied"
              : state.submitted === "uncertain"
                ? "uncertain"
                : "not_applied",
          ),
        });
      }
    },
    subscribe: async (args: { id: string }, api: ToolExecutionApi, context: Context) => {
      try {
        const binding = await api.commit((tx) => bindingFor(tx, args.id), context);
        return await exclusive(binding.terminal, async () => {
          const agent = await resolve(binding, context);
          await api.commit((tx) => observe(tx, agent), context);
          await subscribe(args.id, agent, false, true, api, context);
          return result({ ok: true, id: args.id, subscribed: true });
        });
      } catch (error) {
        context.abortSignal?.throwIfAborted();
        return result({
          ok: false,
          id: args.id,
          subscribed: false,
          error: normalize("subscribe", error, "none"),
        });
      }
    },
    delete: async (args: { id: string }, api: ToolExecutionApi, context: Context) => {
      const state: { deleted: boolean | "uncertain" } = { deleted: false };
      try {
        const binding = await api.commit((tx) => bindingFor(tx, args.id), context);
        return await exclusive(binding.terminal, async () => {
          if (binding.retired)
            throw new AgentFailure("replaced", "Agent identity has been replaced");
          let absent = false;
          try {
            const { pane } = z
              .object({ pane: z.object({ terminal_id: z.string() }) })
              .parse(await client.request("pane.get", { pane_id: binding.pane }, context));
            if (pane.terminal_id !== binding.terminal)
              throw new AgentFailure("replaced", "Agent identity has been replaced");
            await resolve(binding, context);
          } catch (error) {
            if (
              error instanceof HerdrError &&
              ["pane_not_found", "terminal_not_found"].includes(error.code)
            )
              absent = true;
            else throw error;
          }
          if (!absent) {
            await api.commit(async (tx) => {
              const subscriptions = await tx.doc(Subscriptions, api.conversationId);
              for (const [key, task] of Object.entries(subscriptions.agents))
                if (key.startsWith(`${args.id}:`))
                  (await tx.doc(WatchControl, task)).deleting = true;
            }, context);
            state.deleted = "uncertain";
            try {
              await client.request("pane.close", { pane_id: binding.pane }, context);
              state.deleted = true;
            } catch (error) {
              if (error instanceof HerdrError && error.code === "pane_not_found")
                state.deleted = false;
              else throw error;
            }
          }
          await api.commit(async (tx) => {
            const subscriptions = await tx.doc(Subscriptions, api.conversationId);
            for (const [key, task] of Object.entries(subscriptions.agents))
              if (key.startsWith(`${args.id}:`)) (await tx.doc(WatchControl, task)).deleted = true;
          }, context);
          return result({ ok: true, id: args.id, deleted: state.deleted });
        });
      } catch (error) {
        context.abortSignal?.throwIfAborted();
        return result({
          ok: false,
          id: args.id,
          deleted: state.deleted,
          error:
            state.deleted === "uncertain"
              ? failure(
                  "delete",
                  "delete_uncertain",
                  "Terminal closure could not be confirmed",
                  "uncertain",
                )
              : normalize("delete", error, state.deleted ? "applied" : "not_applied"),
        });
      }
    },
  };
}
