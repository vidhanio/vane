import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  getCurrentSystemMessage,
  Type,
  type Message,
  type Models,
  type SystemMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
  LiveDoc,
  ProviderDoc,
  UsageDoc,
  type Conversation,
  type EntryId,
  type EntryRecord,
  type Harness,
} from "@earendil-works/pi-durable";
import { Mutex } from "async-mutex";
import { join } from "node:path";
import type { BotConfig } from "../config.ts";
import { AgentNotification } from "../messages.ts";
import { requestModels, zeroUsage } from "./models.ts";
import { createCompressor } from "./compactor.ts";
import { clip, Memory, split } from "./index.ts";
import type { Kind } from "./store.ts";

const context = BACKGROUND_CONTEXT;
const noop = () => {};
const Archive = defineDoc<{
  count: number;
  cursor?: EntryId;
  turn?: { entry: EntryId; view: string; ordinal: number };
}>({
  kind: "vane.memory.archive",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ count: 0 }),
});

export class MemoryAgent {
  readonly models: Models;
  private readonly cachedModels: Models;
  private readonly syncing = new Mutex();
  private readonly shutdown = new AbortController();
  private readonly first = new Map<number, number>();
  private conversation: Conversation | undefined;
  private harness: Harness | undefined;
  private memory: Memory | undefined;
  private system: SystemMessage | undefined;
  private readonly promptReady = Promise.withResolvers<SystemMessage>();
  private cursor: EntryId | undefined;
  private dirty = false;
  private background: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly config: BotConfig,
    models: Models,
  ) {
    this.cachedModels = requestModels(models, { cache: true });
    this.models = requestModels(this.cachedModels, {
      project: (messages, signal) => this.project(messages, signal),
    });
  }

  extension() {
    return defineExtension({
      name: "vane.memory",
      tools: [
        defineTool({
          name: "zoom",
          description:
            "Open memory line id+n into its two child summaries. n must be a power of two and id a multiple of n. With n=1 return the original message and images; use offset for subsequent pages.",
          parameters: Type.Object(
            {
              id: Type.Integer({ minimum: 0 }),
              n: Type.Integer({ minimum: 1 }),
              offset: Type.Optional(Type.Integer({ minimum: 0 })),
            },
            { additionalProperties: false },
          ),
          replay: "safe",
          outputLimits: { maxBytes: 120_000, maxLines: 30_000 },
          execute: async ({ id, n, offset }, api, callContext) => {
            const memory = this.requireMemory();
            const text = memory.zoom(id, n, offset);
            const output: (
              { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
            )[] = [{ type: "text", text }];
            if (n === 1 && !offset) {
              const record = memory.store.records[id];
              if (!record) throw new Error(`No memory message ${id}`);
              const source = record.source;
              const entry = await api.commit(
                (tx) => tx.entry(source.entry as EntryId),
                callContext,
              );
              if (!entry) throw new Error("The original durable message is missing");
              const message = entry.model?.[source.message];
              if (message && typeof message.content !== "string")
                for (const block of message.content) if (block.type === "image") output.push(block);
            }
            return { output };
          },
        }),
        defineTool({
          name: "date",
          description: "Return the original date and time of memory message id.",
          parameters: Type.Object(
            { id: Type.Integer({ minimum: 0 }) },
            { additionalProperties: false },
          ),
          replay: "safe",
          execute: async ({ id }) => {
            const record = this.requireMemory().store.records[id];
            if (!record) throw new Error(`No memory message ${id}`);
            return { output: [{ type: "text", text: record.date }] };
          },
        }),
      ],
    });
  }

  async bind(conversation: Conversation, harness: Harness): Promise<void> {
    this.conversation = conversation;
    this.harness = harness;
    const { archived, sessionId } = await conversation.commit(
      async (tx) => ({
        archived: { ...(await tx.doc(Archive, conversation.id)) },
        sessionId: (await tx.doc(ProviderDoc, conversation.id)).sessionId,
      }),
      context,
    );
    this.cursor = archived.cursor;
    this.memory = await Memory.open(
      join(this.config.state_dir, "memory"),
      createCompressor(
        this.cachedModels,
        this.config.memory,
        async (signal) => {
          if (this.system) return this.system;
          signal.throwIfAborted();
          let abort = noop;
          const cancelled = new Promise<never>((_resolve, reject) => {
            abort = () => reject(new Error("Compaction cancelled"));
            signal.addEventListener("abort", abort, { once: true });
          });
          try {
            return await Promise.race([this.promptReady.promise, cancelled]);
          } finally {
            signal.removeEventListener("abort", abort);
          }
        },
        (usage) => this.recordUsage(usage),
        sessionId,
      ),
    );
    if (this.memory.store.records.length < archived.count)
      throw new Error("The memory log is behind its durable cursor; refusing to lose chat history");
    for (const record of this.memory.store.records)
      if (!this.first.has(record.source.entry)) this.first.set(record.source.entry, record.i);
    const view = await conversation.viewState(context);
    this.unsubscribe = view.subscribe(() => this.refresh());
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = () => {
      unsubscribe();
      view.dispose();
    };
    await this.sync();
  }

  private requireConversation(): Conversation {
    if (!this.conversation) throw new Error("Memory is not bound to a conversation");
    return this.conversation;
  }

  private requireMemory(): Memory {
    if (!this.memory) throw new Error("Memory is not open");
    return this.memory;
  }

  private async recordUsage(usage: Usage): Promise<void> {
    if (this.shutdown.signal.aborted) return;
    const conversation = this.requireConversation();
    await conversation.commit(async (tx) => {
      const state = await tx.doc(UsageDoc, conversation.id);
      const name = `${this.config.memory.provider}/${this.config.memory.model_id}`;
      const total = (state.models[name] ??= zeroUsage());
      for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
        total[field] += usage[field];
      if (usage.cacheWrite1h !== undefined)
        total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
      for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
        total.cost[field] += usage.cost[field];
    }, context);
  }

  private refresh(): void {
    if (this.shutdown.signal.aborted) return;
    this.dirty = true;
    if (this.background) return;
    this.background = (async () => {
      while (this.dirty && !this.shutdown.signal.aborted) {
        this.dirty = false;
        await this.sync();
      }
    })()
      .catch((error: unknown) => console.error("Memory archive failed", error))
      .finally(() => {
        this.background = undefined;
      });
  }

  private sync(): Promise<void> {
    return this.syncing.runExclusive(async () => {
      const conversation = this.requireConversation();
      let cursor;
      do {
        const page = await conversation.entries(
          { ...(this.cursor === undefined ? {} : { minEntryId: this.cursor }), order: "ascending" },
          100,
          cursor,
          context,
        );
        for (const entry of page.items) {
          if (this.cursor !== undefined && entry.id <= this.cursor) continue;
          await this.archive(entry);
          await conversation.commit(async (tx) => {
            const state = await tx.doc(Archive, conversation.id);
            state.cursor = entry.id;
            state.count = this.requireMemory().store.records.length;
          }, context);
          this.cursor = entry.id;
        }
        cursor = page.next;
      } while (cursor);
    });
  }

  private async archive(entry: EntryRecord): Promise<void> {
    const memory = this.requireMemory();
    const append = async (
      kind: Kind,
      text: string,
      message: number,
      block: string,
      timestamp: number,
    ) => {
      const parts = kind === "echo" ? [clip(text)] : split(text);
      for (const [piece, part] of parts.entries()) {
        const i = await memory.append(
          kind,
          part,
          new Date(timestamp).toISOString(),
          `${entry.id}:${message}:${block}:${piece}`,
          { entry: entry.id, message },
        );
        if (!this.first.has(entry.id)) this.first.set(entry.id, i);
      }
    };
    for (const [index, message] of (entry.model ?? []).entries()) {
      if (message.role === "system") continue;
      if (message.role === "assistant") {
        for (const [blockIndex, block] of message.content.entries()) {
          if (block.type === "text")
            await append("vane", block.text, index, String(blockIndex), message.timestamp);
          else if (block.type === "toolCall") {
            await append(
              "tool",
              `${block.name} ${JSON.stringify(block.arguments)}`,
              index,
              String(blockIndex),
              message.timestamp,
            );
            if (block.name === "reply" && typeof block.arguments.text === "string")
              await append(
                "vane",
                block.arguments.text,
                index,
                `${blockIndex}:reply`,
                message.timestamp,
              );
          }
        }
      } else {
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content
                .map((block) =>
                  block.type === "text"
                    ? block.text
                    : "[image: use zoom on this message to retrieve]",
                )
                .join("\n");
        await append(
          message.role === "toolResult"
            ? "echo"
            : AgentNotification.is(entry)
              ? "work"
              : entry.kind === "pi.compaction"
                ? "note"
                : "user",
          message.role === "toolResult"
            ? `${message.toolName}${message.isError ? " (error)" : ""}: ${text}`
            : text,
          index,
          "content",
          message.timestamp,
        );
      }
    }
  }

  private async project(messages: readonly Message[], signal?: AbortSignal): Promise<Message[]> {
    const conversation = this.conversation;
    if (!conversation) throw new Error("Memory is not bound to the conversation");
    this.system = getCurrentSystemMessage(messages);
    if (!this.system) throw new Error("Missing system prompt for memory turn");
    this.promptReady.resolve(this.system);
    await this.sync();
    const memory = this.requireMemory();
    const first = await conversation.commit(
      async (tx) => (await tx.doc(LiveDoc, conversation.id)).run?.inputs[0],
      context,
    );
    const submission =
      first === undefined
        ? undefined
        : await (await this.harness?.submission(first, context))?.status(context);
    if (submission?.entry === undefined) throw new Error("Missing active turn input");
    const entryId = submission.entry;
    const input = await conversation.commit(async (tx) => {
      const entry = await tx.entry(entryId);
      if (!entry) throw new Error("Missing active input entry");
      const state = await tx.doc(Archive, conversation.id);
      return { entry, saved: state.turn?.entry === entry.id ? { ...state.turn } : undefined };
    }, context);
    const user = input.entry.model?.find((message) => message.role === "user");
    if (!user) throw new Error("Active turn has no user message");
    const ordinal =
      input.saved?.ordinal ??
      (await conversation.context(context, { at: input.entry.id })).messages.filter(
        (message) => message.role === "user",
      ).length - 1;
    let seen = 0;
    const index = messages.findIndex((message) => message.role === "user" && seen++ === ordinal);
    const active = messages[index];
    if (
      active?.role !== "user" ||
      active.timestamp !== user.timestamp ||
      JSON.stringify(active.content) !== JSON.stringify(user.content)
    )
      throw new Error("Active turn input is absent from the request");
    let view = input.saved?.view;
    if (view === undefined) {
      const boundary = this.first.get(input.entry.id);
      if (boundary === undefined) throw new Error("Active input is absent from memory");
      memory.retry();
      await memory.settle(boundary, signal);
      view = memory.chat.render(boundary);
      const saved = view;
      await conversation.commit(async (tx) => {
        (await tx.doc(Archive, conversation.id)).turn = {
          entry: input.entry.id,
          view: saved,
          ordinal,
        };
      }, context);
    }
    signal?.throwIfAborted();
    return [
      this.system,
      { role: "user", content: [{ type: "text", text: view }], timestamp: 0 },
      {
        role: "user",
        content: `[turn started: ${new Date(user.timestamp).toISOString()}]`,
        timestamp: user.timestamp,
      },
      ...messages.slice(index).filter((message) => message.role !== "system"),
    ];
  }

  private detach(): void {
    this.shutdown.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  async prepareClose(): Promise<void> {
    this.detach();
    await this.background;
    await this.sync();
  }

  async close(): Promise<void> {
    this.detach();
    await this.background;
    await this.memory?.close();
  }
}
