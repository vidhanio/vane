import type { JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  EntryId,
  SnapshotEvent,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { SessionRef, ToolCallEvent } from "./platform.ts";
import { describeTool, toolDisplay } from "./tool-display.ts";

function resultOutput(message: ToolResultMessage): string {
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

export class ToolCalls {
  private readonly calls = new Map<string, ToolCallEvent>();
  private readonly tools: Map<string, ToolRegistration>;

  constructor(
    private readonly session: SessionRef,
    tools: readonly ToolRegistration[],
  ) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  snapshot(snapshot: SnapshotEvent): ToolCallEvent[] {
    const events: ToolCallEvent[] = [];
    const active = new Set(snapshot.tools.map((slot) => slot.callId));
    for (const call of this.calls.values()) {
      if (call.status !== "done" && !active.has(call.callId))
        events.push(this.save({ ...call, status: "done" }));
    }
    if (snapshot.tools.length === 0) return events;
    const argumentsById = new Map<string, JsonObject>();
    const results = new Map<EntryId, ToolResultMessage>();
    for (const entry of snapshot.entries) {
      for (const message of entry.model ?? []) {
        if (message.role === "toolResult") results.set(entry.id, message);
        else if (message.role === "assistant") {
          for (const block of message.content) {
            if (block.type === "toolCall") argumentsById.set(block.id, block.arguments);
          }
        }
      }
    }
    for (const slot of snapshot.tools) {
      const result = slot.entry === undefined ? undefined : results.get(slot.entry);
      const display = toolDisplay(slot.details ?? result?.details);
      const tool = this.tools.get(slot.name);
      const details =
        display?.call ?? (tool ? describeTool(tool, argumentsById.get(slot.callId)) : undefined);
      events.push(
        this.save({
          type: "tool-call",
          session: this.session,
          callId: slot.callId,
          name: slot.name,
          status: slot.status,
          ...(details === undefined ? {} : { details }),
          output: slot.output ?? (result ? resultOutput(result) : ""),
          ...(display?.result === undefined ? {} : { resultDetails: display.result }),
        }),
      );
    }
    return events;
  }

  update(event: AgentEvent): ToolCallEvent | undefined {
    if (
      event.type !== "tool_execution_start" &&
      event.type !== "tool_execution_update" &&
      event.type !== "tool_execution_end"
    )
      return undefined;
    let call: ToolCallEvent = this.calls.get(event.toolCallId) ?? {
      type: "tool-call",
      session: this.session,
      callId: event.toolCallId,
      name: event.toolName,
      status: "running",
    };
    if (event.type === "tool_execution_start") {
      const tool = this.tools.get(event.toolName);
      const details = tool ? describeTool(tool, event.args) : undefined;
      call = {
        ...call,
        status: "running",
        output: "",
        resultDetails: null,
        ...(details === undefined ? {} : { details }),
      };
    } else if (event.type === "tool_execution_update") {
      if (event.output) {
        const output =
          "set" in event.output
            ? event.output.set
            : (call.output ?? "").slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
        call = { ...call, output };
      }
      if (event.details !== undefined) {
        const display = toolDisplay(event.details);
        call = {
          ...call,
          ...(display === undefined ? {} : { details: display.call }),
          resultDetails: display?.result ?? null,
        };
      }
    } else {
      const message = event.entry?.model?.[0];
      const result = message?.role === "toolResult" ? message : undefined;
      const display = toolDisplay(result?.details);
      call = {
        ...call,
        status: "done",
        ...(result === undefined ? {} : { output: resultOutput(result) }),
        ...(display === undefined ? {} : { details: display.call }),
        ...(display?.result === undefined ? {} : { resultDetails: display.result }),
      };
    }
    return this.save(call);
  }

  private save(call: ToolCallEvent): ToolCallEvent {
    this.calls.set(call.callId, call);
    return call;
  }
}
