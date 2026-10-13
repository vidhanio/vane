#!/usr/bin/env bun

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Bot } from "./bot.ts";
import { loadConfig, type BotConfig } from "./config.ts";
import type { Platform, PlatformDefinition } from "./platform.ts";
import { discordPlatform } from "./platforms/discord.ts";

const definitions: Record<string, PlatformDefinition> = {
  [discordPlatform.name]: discordPlatform,
};

function configPath(): string {
  const args = process.argv.slice(2);
  if (args.length === 0)
    return join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "vidhan-bot/config.toml",
    );
  if (args.length === 2 && args[0] === "--config" && args[1]) return resolve(args[1]);
  throw new Error("Usage: vidhan-bot [--config PATH]");
}

function platforms(config: BotConfig): Platform[] {
  const entries = Object.entries(config.platforms);
  if (entries.length === 0)
    throw new Error("No platforms enabled; add a [platforms.<name>] table to the config");
  return entries.map(([name, raw]) => {
    const definition = definitions[name];
    if (!definition) throw new Error(`Unknown platform: ${name}`);
    try {
      return definition.create(raw);
    } catch (error) {
      throw new Error(`Invalid [platforms.${name}] configuration`, { cause: error });
    }
  });
}

function waitForSignal(): Promise<void> {
  const stop = Promise.withResolvers<void>();
  const signal = () => stop.resolve();
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  return stop.promise.finally(() => {
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
  });
}

async function main(): Promise<void> {
  process.umask(0o077);
  const config = await loadConfig(configPath());
  const enabled = platforms(config);
  const bot = await Bot.open(config);
  try {
    for (const platform of enabled) await platform.start(bot.host(platform.name));
    console.log(
      `vidhan-bot ready; platforms: ${enabled.map((platform) => platform.name).join(", ")}; state: ${config.state_dir}`,
    );
    await waitForSignal();
  } finally {
    await Promise.allSettled(enabled.map((platform) => platform.stop()));
    await bot.close();
  }
}

main().catch((error: unknown) => {
  console.error("vidhan-bot failed", error);
  process.exitCode = 1;
});
