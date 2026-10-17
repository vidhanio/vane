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
import { MemoryAgent } from "./memory/agent.ts";

const context = BACKGROUND_CONTEXT;

/** Owns the single shared DM session and its durable runtime. */
export class Bot {
  private constructor(
    readonly harness: Harness,
    readonly session: Session,
    private readonly memory: MemoryAgent,
    private readonly release: () => Promise<void>,
  ) {}

  static async open(config: BotConfig): Promise<Bot> {
    const models = builtinModels();
    if (!models.getModel(config.agent.provider, config.agent.model_id))
      throw new Error(`Unknown model ${config.agent.provider}/${config.agent.model_id}`);
    if (!(await models.getAuth(config.agent.provider)))
      throw new Error(`Missing authentication for ${config.agent.provider}`);
    if (!models.getModel(config.memory.provider, config.memory.model_id))
      throw new Error(`Unknown memory model ${config.memory.provider}/${config.memory.model_id}`);
    if (!(await models.getAuth(config.memory.provider)))
      throw new Error(`Missing authentication for ${config.memory.provider}`);
    await mkdir(config.state_dir, { recursive: true, mode: 0o700 });
    const release = await lock(config.state_dir, {
      retries: { retries: 5, minTimeout: 1000, maxTimeout: 3000 },
    });
    try {
      const registry = createRegistry();
      registry.install(CodingTools);
      registry.install(botTools(config));
      const memory = new MemoryAgent(config, models);
      registry.install(memory.extension());
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
      log("agent.opened", {
        stateDir: config.state_dir,
        provider: config.agent.provider,
        model: config.agent.model_id,
      });
      const session = await harness
        .root(context, {
          agent: {
            model: { provider: config.agent.provider, modelId: config.agent.model_id },
            thinkingLevel: config.agent.thinking,
            cwd: config.agent.cwd,
          },
        })
        .then(async (conversation) => {
          await memory.bind(conversation, harness);
          return Session.open(conversation);
        })
        .catch(async (error: unknown) => {
          try {
            await harness.close(context);
          } finally {
            await memory.close();
          }
          throw error;
        });
      harness.resume();
      return new Bot(harness, session, memory, release);
    } catch (error) {
      await release();
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      try {
        await this.session.close();
        await this.memory.prepareClose();
      } finally {
        try {
          await this.harness.close(context);
        } finally {
          await this.memory.close();
        }
      }
    } finally {
      await this.release();
    }
  }
}
