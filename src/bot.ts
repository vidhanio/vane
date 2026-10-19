import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import type { BotConfig } from "./config.ts";
import { botTools } from "./tools.ts";
import { log } from "./log.ts";
import { Session } from "./session.ts";
import { toolNotices } from "./tool-notices.ts";
import { replyTool } from "./reply.ts";
import { MemoryAgent } from "./memory/agent.ts";

const context = BACKGROUND_CONTEXT;

/** Owns the single shared DM session and its durable runtime. */
export class Bot {
  private closing: Promise<void> | undefined;

  private constructor(
    readonly harness: Harness,
    readonly session: Session,
    private readonly resources: AsyncDisposableStack,
  ) {}

  static async open(config: BotConfig): Promise<Bot> {
    const models = builtinModels();
    for (const [name, choice] of Object.entries({ agent: config.agent, memory: config.memory })) {
      if (!models.getModel(choice.provider, choice.model_id))
        throw new Error(`Unknown ${name} model ${choice.provider}/${choice.model_id}`);
      if (!(await models.getAuth(choice.provider)))
        throw new Error(`Missing authentication for ${choice.provider}`);
    }
    await using resources = new AsyncDisposableStack();
    await mkdir(config.state_dir, { recursive: true, mode: 0o700 });
    resources.defer(
      await lock(config.state_dir, {
        retries: { retries: 5, minTimeout: 1000, maxTimeout: 3000 },
      }),
    );
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(botTools(config));
    const memory = new MemoryAgent(config, models);
    resources.defer(() => memory.close());
    registry.install(memory.extension());
    registry.install(
      toolNotices(
        registry
          .snapshot()
          .tools()
          .map(({ tool }) => tool),
      ),
    );
    const storage = await openNodeSqliteStorage(join(config.state_dir, "vane.sqlite"));
    const harness = await Harness.open(
      storage,
      {
        models: memory.models,
        registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.agent.cwd }),
        settings: {
          toolExecution: "parallel",
          compaction: { enabled: false },
        },
        onReport: (error) => console.error("Agent error", error),
      },
      context,
    ).catch(async (error: unknown) => {
      await storage.close(context);
      throw error;
    });
    resources.defer(() => harness.close(context));
    const blocked = (await harness.inspect(context)).tasks.filter(
      (task) => task.state.kind === "blocked",
    );
    if (blocked.length)
      throw new Error(
        `Cannot resume unavailable tasks: ${blocked.map(({ record }) => `${record.kind} (${record.id})`).join(", ")}. Drain or abort them with the previous executable before upgrading.`,
      );
    const conversation = await harness.root(context);
    await conversation.configure(
      {
        model: { provider: config.agent.provider, modelId: config.agent.model_id },
        thinkingLevel: config.agent.thinking,
        cwd: config.agent.cwd,
      },
      context,
    );
    if (!(await conversation.agent(context)).tools.some((tool) => tool.name === replyTool.name))
      throw new Error("The configured toolset must include reply.");
    await memory.bind(conversation, harness);
    resources.defer(() => memory.prepareClose());
    const session = await Session.open(conversation);
    resources.defer(() => session.close());
    harness.resume();
    log("agent.opened", {
      stateDir: config.state_dir,
      provider: config.agent.provider,
      model: config.agent.model_id,
    });
    return new Bot(harness, session, resources.move());
  }

  close(): Promise<void> {
    return (this.closing ??= this.resources.disposeAsync());
  }
}
