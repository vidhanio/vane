export { Bot } from "./bot.ts";
export {
  botConfigSchema,
  expandEnvironment,
  loadConfig,
  validateBotConfig,
  type BotConfig,
} from "./config.ts";
export { discordPlatform } from "./platforms/discord.ts";
export { PlatformMessage } from "./platform.ts";
export type {
  Attachment,
  IncomingMessage,
  Platform,
  PlatformDefinition,
  PlatformHost,
} from "./platform.ts";
