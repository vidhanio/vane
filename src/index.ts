export { Bot } from "./bot.ts";
export {
  botConfigSchema,
  expandEnvironment,
  loadConfig,
  validateBotConfig,
  type BotConfig,
} from "./config.ts";
export { discordPlatform } from "./platforms/discord.ts";
export type {
  Attachment,
  BotEvent,
  IncomingMessage,
  Platform,
  PlatformDefinition,
  PlatformHost,
  SessionInfo,
  SessionRef,
  ToolCallDetails,
  ToolCallEvent,
} from "./platform.ts";
