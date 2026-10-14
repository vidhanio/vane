import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  configure,
  createRegistry,
  defineDoc,
  Harness,
  type Conversation,
  type ConversationId,
  type UserInput,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import type { BotConfig } from "./config.ts";
import { PlatformMessage, type IncomingMessage, type PlatformHost } from "./platform.ts";
import { botTools } from "./tools.ts";
import { log } from "./log.ts";

const context = BACKGROUND_CONTEXT;

const Sessions = defineDoc<{ platforms: Record<string, Record<string, ConversationId>> }>({
  kind: "vidhan-bot.sessions",
  version: 1,
  scope: "session",
  initial: () => ({ platforms: {} }),
});

function formatMessage(message: IncomingMessage): UserInput {
  const parts: (TextContent | ImageContent)[] = [
    { type: "text", text: `${message.author}: ${message.text}` },
  ];
  for (const attachment of message.attachments ?? []) {
    parts.push({ type: "text", text: `Attachment (untrusted URL): ${attachment.url}` });
    if (attachment.image) parts.push(attachment.image);
  }
  return parts;
}

/** Owns the pi harness and maps platform sessions to its conversations. */
export class Bot {
  private constructor(
    readonly harness: Harness,
    readonly config: BotConfig,
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
      return new Bot(harness, config, release);
    } catch (error) {
      await release();
      throw error;
    }
  }

  /** Bind routing and request ids to one platform. */
  host(platform: string): PlatformHost {
    const sessions = async () =>
      (await this.harness.snapshot(Sessions, context))?.platforms[platform] ?? {};
    const find = async (id: string) => {
      const conversationId = (await sessions())[id];
      return conversationId ? this.harness.conversation(conversationId, context) : undefined;
    };
    const conversation = async (id: string) => {
      const existing = await find(id);
      if (existing) return existing;
      return this.conversation(platform, id);
    };
    return {
      sessions: async () => Object.keys(await sessions()),
      find,
      conversation,
      submit: async (message) => {
        const session = await conversation(message.session);
        const submission = await session.submit(
          {
            type: "input",
            content: formatMessage(message),
            requestId: `${platform}:${message.id}`,
            entry: { kind: PlatformMessage.kind, data: { id: message.id, author: message.author } },
          },
          context,
        );
        log("message.submitted", {
          platform,
          sessionId: message.session,
          messageId: message.id,
          submissionId: submission.id,
        });
        return submission;
      },
    };
  }

  async close(): Promise<void> {
    try {
      await this.harness.close(context);
    } finally {
      await this.release();
    }
  }

  private async conversation(platform: string, id: string): Promise<Conversation> {
    const conversationId = await this.harness.commit(async (tx) => {
      const sessions = await tx.doc(Sessions);
      const entries = sessions.platforms[platform];
      const existing = entries?.[id];
      if (existing) return existing;
      const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, created.id, {
        model: { provider: this.config.agent.provider, modelId: this.config.agent.model_id },
        thinkingLevel: this.config.agent.thinking,
        cwd: this.config.agent.cwd,
      });
      sessions.platforms[platform] = { ...entries, [id]: created.id };
      log("session.created", { platform, sessionId: id, conversationId: created.id });
      return created.id;
    }, context);
    const conversation = await this.harness.conversation(conversationId, context);
    if (!conversation) throw new Error(`Missing session ${platform}/${id}`);
    return conversation;
  }
}
