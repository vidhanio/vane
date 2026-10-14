import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  createRegistry,
  defineDoc,
  Harness,
  LiveDoc,
  UsageDoc,
  watchEvents,
  type Conversation,
  type ConversationId,
  type EntryId,
  type ToolRegistration,
  type UserInput,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
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
import { ToolCalls } from "./tool-events.ts";
import { log } from "./log.ts";

const context = BACKGROUND_CONTEXT;

const Sessions = defineDoc<{ platforms: Record<string, Record<string, ConversationId>> }>({
  kind: "vidhan-bot.sessions",
  version: 1,
  scope: "session",
  initial: () => ({ platforms: {} }),
});

function formatMessage(message: IncomingMessage, images: boolean): UserInput {
  const parts: (TextContent | ImageContent)[] = [
    { type: "text", text: `${message.author}: ${message.text}` },
  ];
  for (const attachment of message.attachments ?? []) {
    parts.push({ type: "text", text: `Attachment (untrusted URL): ${attachment.url}` });
    if (images && attachment.image) parts.push(attachment.image);
  }
  return parts;
}

/** Owns conversations, persistence and model calls. Platforms only see this surface. */
export class Bot {
  private readonly listeners = new Set<(event: BotEvent) => void | Promise<void>>();

  private constructor(
    readonly harness: Harness,
    readonly config: BotConfig,
    private readonly release: () => Promise<void>,
    private readonly models: Models,
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
      return new Bot(harness, config, release, models);
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

  private async ask(message: IncomingMessage): Promise<string | undefined> {
    const { session } = message;
    log("turn.started", {
      ...session,
      messageId: message.id,
      textLength: message.text.length,
      attachments: message.attachments?.length ?? 0,
    });
    this.emit({ type: "turn-start", session });
    let stopTools: (() => Promise<void>) | undefined;
    try {
      const conversation = await this.conversation(session);
      const agent = await conversation.agent(context);
      stopTools = await this.watchTools(session, conversation, agent.tools);
      const model = agent.model
        ? this.models.getModel(agent.model.provider, agent.model.modelId)
        : undefined;
      const images = model?.input.includes("image") ?? false;
      if (!images && message.attachments?.some((attachment) => attachment.image)) {
        log("agent.images_unsupported", {
          ...session,
          provider: agent.model?.provider,
          model: agent.model?.modelId,
        });
      }
      const result = await (
        await conversation.submit(
          {
            type: "input",
            content: formatMessage(message, images),
            requestId: `${session.platform}:${message.id}`,
          },
          context,
        )
      ).wait(context);
      await stopTools();
      const answer =
        result.status === "done" && result.type === "input"
          ? await this.answerText(conversation, result.answer)
          : result.status === "unanswered" && result.reason === "aborted"
            ? undefined
            : `Session ended without an answer: ${result.status === "unanswered" ? result.reason : result.status}.`;
      log("turn.finished", {
        ...session,
        messageId: message.id,
        status: result.status,
        answerLength: answer?.length ?? 0,
      });
      this.emit({ type: "turn-end", session, ...(answer === undefined ? {} : { answer }) });
      return answer;
    } catch (error) {
      await stopTools?.();
      this.emit({ type: "turn-error", session, error });
      throw error;
    }
  }

  private async watchTools(
    session: SessionRef,
    conversation: Conversation,
    tools: readonly ToolRegistration[],
  ): Promise<() => Promise<void>> {
    const calls = new ToolCalls(session, tools);
    let stopped = false;
    const stream = await watchEvents(this.harness, conversation.id, context);
    for (const call of calls.snapshot(stream.snapshot)) this.emit(call);
    stream.start(async (events) => {
      for (const event of events) {
        if (stopped) return;
        if (event.type === "snapshot") {
          for (const call of calls.snapshot(event)) this.emit(call);
          continue;
        }
        const call = calls.update(event);
        if (!call) continue;
        if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
          log(event.type === "tool_execution_start" ? "tool.started" : "tool.finished", {
            ...session,
            callId: call.callId,
            tool: call.name,
          });
        }
        this.emit(call);
      }
    });
    void stream.closed.then((end) => {
      if (!stopped) console.error("Tool event stream closed unexpectedly", { ...session, end });
    });
    return async () => {
      stopped = true;
      await stream.stop();
    };
  }

  private async stop(session: SessionRef): Promise<void> {
    log("turn.stop_requested", { ...session });
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
    for (const listener of this.listeners) {
      try {
        const work = listener(event);
        if (work)
          void Promise.resolve(work).catch((error: unknown) =>
            console.error("Platform listener failed", {
              type: event.type,
              session: event.session,
              error,
            }),
          );
      } catch (error) {
        console.error("Platform listener failed", {
          type: event.type,
          session: event.session,
          error,
        });
      }
    }
  }

  private on(platform: string, listener: (event: BotEvent) => void | Promise<void>): () => void {
    const scoped = (event: BotEvent) => {
      if (event.session.platform === platform) return listener(event);
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
      log("session.created", { ...ref, conversationId: created.id });
      return created.id;
    }, context);
    const conversation = await this.harness.conversation(id, context);
    if (!conversation) throw new Error(`Missing session ${ref.platform}/${ref.id}`);
    return conversation;
  }
}
