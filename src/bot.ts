import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { configure, createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import type { BotConfig } from "./config.ts";
import { botTools } from "./tools.ts";
import { log } from "./log.ts";

const context = BACKGROUND_CONTEXT;

/** Owns the shared pi session and configures new independent conversations. */
export class Bot {
  private constructor(
    readonly harness: Harness,
    private readonly release: () => Promise<void>,
  ) {}

  static async open(config: BotConfig): Promise<Bot> {
    const models = builtinModels();
    if (!models.getModel(config.agent.provider, config.agent.model_id))
      throw new Error(`Unknown model ${config.agent.provider}/${config.agent.model_id}`);
    if (!(await models.getAuth(config.agent.provider)))
      throw new Error(`Missing authentication for ${config.agent.provider}`);
    await mkdir(config.state_dir, { recursive: true, mode: 0o700 });
    const release = await lock(config.state_dir, {
      retries: { retries: 5, minTimeout: 1000, maxTimeout: 3000 },
    });
    try {
      const registry = createRegistry();
      registry.install(CodingTools);
      registry.install(botTools(config));
      const storage = await openNodeJsonlStorage(join(config.state_dir, "sessions"), context, {
        fsync: true,
      });
      const harness = await Harness.open(
        storage,
        {
          models,
          registry,
          env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.agent.cwd }),
          settings: { toolExecution: "parallel" },
          conversationCreated: async (tx, conversation) => {
            if (conversation.owner || conversation.parent) return;
            await configure(tx, conversation.id, {
              model: { provider: config.agent.provider, modelId: config.agent.model_id },
              thinkingLevel: config.agent.thinking,
              cwd: config.agent.cwd,
            });
          },
          onReport: (error) => console.error("Agent error", error),
        },
        context,
      ).catch(async (error: unknown) => {
        await storage.close(context);
        throw error;
      });
      harness.resume();
      log("agent.opened", {
        stateDir: config.state_dir,
        provider: config.agent.provider,
        model: config.agent.model_id,
      });
      return new Bot(harness, release);
    } catch (error) {
      await release();
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      await this.harness.close(context);
    } finally {
      await this.release();
    }
  }
}
