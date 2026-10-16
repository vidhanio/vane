import { defineEntry, type EntryId, type EntryRecord, type Tx } from "@earendil-works/pi-durable";

export type MessageOrigin = { platform: string; channelId: string; messageId: string };

export const DirectMessage = defineEntry<MessageOrigin>("vane.message");
export const AgentNotification = defineEntry<{ requestId: string; origin: EntryId }>(
  "vane.notification",
);

export function messageRequestId(origin: MessageOrigin): string {
  return `${origin.platform}:${origin.channelId}:${origin.messageId}`;
}

export async function resolveMessageOrigin(tx: Tx, input: EntryRecord): Promise<MessageOrigin> {
  const source = AgentNotification.is(input) ? await tx.entry(input.data.origin) : input;
  if (!source || !DirectMessage.is(source))
    throw new Error(`Missing message origin for input ${input.id}`);
  return source.data;
}
