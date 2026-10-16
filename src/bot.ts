import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
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

const context = BACKGROUND_CONTEXT;

/** Owns the single shared DM session and its durable runtime. */
export class Bot {
  private constructor(
    readonly harness: Harness,
    readonly session: Session,
    private readonly release: () => Promise<void>,
    private readonly sandbox: CodemodeSandbox,
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
    let sandbox: CodemodeSandbox | undefined;
    try {
      sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
      const registry = createRegistry();
      registry.install(CodingTools);
      registry.install(botTools(config));
      registry.install(
        createCodemodeExtension({
          sandbox,
          namespaces: [
            { name: "herdr", description: "Herdr workspaces and agents", prefix: "herdr_" },
          ],
        }),
      );
      const storage = await openNodeSqliteStorage(join(config.state_dir, "vane.sqlite"));
      const harness = await Harness.open(
        storage,
        {
          models,
          registry,
          env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.agent.cwd }),
          settings: { toolExecution: "parallel", steeringMode: "all" },
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
        .then((conversation) => Session.open(conversation))
        .catch(async (error: unknown) => {
          await harness.close(context);
          throw error;
        });
      harness.resume();
      return new Bot(harness, session, release, sandbox);
    } catch (error) {
      try {
        await sandbox?.close();
      } finally {
        await release();
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      try {
        await this.session.close();
      } finally {
        await this.harness.close(context);
      }
    } finally {
      try {
        await this.sandbox.close();
      } finally {
        await this.release();
      }
    }
  }
}
