import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  AssistantEntry,
  configure,
  createRegistry,
  defineDoc,
  Harness,
  LiveDoc,
  UsageDoc,
  type Conversation,
  type ConversationId,
  type EntryId,
  type ToolSlot,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { validateBotConfig, type BotConfig } from "./config.ts";
import type {
  BotEvent,
  IncomingMessage,
  PlatformHost,
  SessionInfo,
  SessionRef,
} from "./platform.ts";
import { botTools } from "./tools.ts";

const context = BACKGROUND_CONTEXT;

const Sessions = defineDoc<{ platforms: Record<string, Record<string, ConversationId>> }>({
  kind: "vidhan-bot.sessions",
  version: 1,
  scope: "session",
  initial: () => ({ platforms: {} }),
});

function formatMessage(message: IncomingMessage): string {
  const lines = [`${message.author}: ${message.text}`];
  for (const attachment of message.attachments ?? [])
    lines.push(`Attachment (untrusted URL): ${attachment.url}`);
  return lines.join("\n");
}

function toolSummary(details: unknown): string | undefined {
  if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
  const record = details as Record<string, unknown>;
  for (const key of ["command", "path", "pattern", "query", "url"]) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const line = value.split("\n", 1)[0] ?? value;
    return line.length > 80 ? `${line.slice(0, 79)}…` : line;
  }
  return undefined;
}

/** Owns conversations, persistence and model calls. Platforms only see this surface. */
export class Bot {
  private readonly listeners = new Set<(event: BotEvent) => void>();

  private constructor(
    readonly harness: Harness,
    readonly config: BotConfig,
    private readonly release: () => Promise<void>,
  ) {}

  static async open(input: unknown): Promise<Bot> {
    const config = await validateBotConfig(input);
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
      return new Bot(harness, config, release);
    } catch (error) {
      await release();
      throw error;
    }
  }

  /** A platform-scoped host. Only events belonging to `platform` reach its listeners. */
  host(platform: string): PlatformHost {
    return {
      ask: (message) => this.ask(message),
      stop: (session) => this.stop(session),
      status: (session) => this.status(session),
      subscribe: (listener) => this.on(platform, listener),
    };
  }

  private async ask(message: IncomingMessage): Promise<string> {
    const { session } = message;
    this.emit({ type: "turn-start", session });
    let poll: { stop(): void } | undefined;
    try {
      const conversation = await this.conversation(session);
      poll = this.pollTools(session, conversation.id);
      const result = await (
        await conversation.submit(
          {
            type: "input",
            content: formatMessage(message),
            requestId: `${session.platform}:${message.id}`,
          },
          context,
        )
      ).wait(context);
      poll.stop();
      const answer =
        result.status === "done" && result.type === "input"
          ? await this.answerText(conversation, result.answer)
          : `Session ended without an answer: ${result.status === "unanswered" ? result.reason : result.status}.`;
      this.emit({ type: "turn-end", session, answer });
      return answer;
    } catch (error) {
      poll?.stop();
      this.emit({ type: "turn-error", session, error });
      throw error;
    }
  }

  private pollTools(session: SessionRef, conversationId: ConversationId): { stop(): void } {
    const seen = new Map<string, ToolSlot["status"]>();
    let stopped = false;
    let pending = false;
    const timer = setInterval(() => {
      if (stopped || pending) return;
      pending = true;
      void this.harness
        .snapshot(LiveDoc, conversationId, context)
        .then((live) => {
          if (stopped) return;
          for (const slot of live?.tools ?? []) {
            if (seen.get(slot.callId) === slot.status) continue;
            seen.set(slot.callId, slot.status);
            const summary = toolSummary(slot.details);
            this.emit({
              type: "tool-call",
              session,
              callId: slot.callId,
              name: slot.name,
              status: slot.status,
              ...(summary === undefined ? {} : { summary }),
            });
          }
        })
        .catch((error: unknown) => console.error("Tool polling failed", error))
        .finally(() => {
          pending = false;
        });
    }, 1000);
    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  private async stop(session: SessionRef): Promise<void> {
    const conversation = await this.find(session);
    await conversation?.abort(context);
  }

  private async status(session: SessionRef): Promise<SessionInfo | undefined> {
    const conversation = await this.find(session);
    if (!conversation) return undefined;
    const [live, usage] = await Promise.all([
      this.harness.snapshot(LiveDoc, conversation.id, context),
      this.harness.snapshot(UsageDoc, conversation.id, context),
    ]);
    const running = live?.tools?.filter((tool) => tool.status === "running").at(-1);
    const activity = !live?.run
      ? "idle"
      : live.compactions?.length
        ? "compacting"
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
    return {
      activity,
      provider: this.config.agent.provider,
      model: this.config.agent.model_id,
      thinking: this.config.agent.thinking,
      cwd: this.config.agent.cwd,
      tokens,
      cost,
    };
  }

  async close(): Promise<void> {
    try {
      await this.harness.close(context);
    } finally {
      await this.release();
    }
  }

  private emit(event: BotEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private on(platform: string, listener: (event: BotEvent) => void): () => void {
    const scoped = (event: BotEvent) => {
      if (event.session.platform === platform) listener(event);
    };
    this.listeners.add(scoped);
    return () => {
      this.listeners.delete(scoped);
    };
  }

  private async answerText(conversation: Conversation, answer: EntryId): Promise<string> {
    const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, answer), context);
    const text = entry?.model
      ?.flatMap((message) =>
        message.role === "assistant"
          ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
          : [],
      )
      .join("\n");
    return text || "Completed with no text response.";
  }

  private async find(ref: SessionRef): Promise<Conversation | undefined> {
    const sessions = await this.harness.snapshot(Sessions, context);
    const id = sessions?.platforms[ref.platform]?.[ref.id];
    return id ? ((await this.harness.conversation(id, context)) ?? undefined) : undefined;
  }

  private async conversation(ref: SessionRef): Promise<Conversation> {
    const id = await this.harness.commit(async (tx) => {
      const sessions = await tx.doc(Sessions);
      const platform = sessions.platforms[ref.platform];
      const existing = platform?.[ref.id];
      if (existing) return existing;
      const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, created.id, {
        model: { provider: this.config.agent.provider, modelId: this.config.agent.model_id },
        thinkingLevel: this.config.agent.thinking,
        cwd: this.config.agent.cwd,
      });
      sessions.platforms[ref.platform] = { ...platform, [ref.id]: created.id };
      return created.id;
    }, context);
    const conversation = await this.harness.conversation(id, context);
    if (!conversation) throw new Error(`Missing session ${ref.platform}/${ref.id}`);
    return conversation;
  }
}
