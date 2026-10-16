import { defineEntry, type EntryId } from "@earendil-works/pi-durable";

export const AgentNotification = defineEntry<{ requestId: string; origin?: EntryId }>(
  "vidhan-bot.notification",
);
