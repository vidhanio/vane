#!/usr/bin/env bun

import { resolve } from "node:path";
import { Bot } from "./bot.ts";
import { loadConfig, type BotConfig } from "./config.ts";
import type { Platform, PlatformDefinition } from "./platform.ts";
import { discordPlatform } from "./platforms/discord.ts";
import { log } from "./log.ts";

const definitions: Record<string, PlatformDefinition> = {
  [discordPlatform.name]: discordPlatform,
};

function configPath(): string {
  const file = process.env.VIDHAN_BOT_CONFIG;
  if (!file) throw new Error("Set VIDHAN_BOT_CONFIG to the config file path");
  return resolve(file);
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

function waitForShutdown(bot: Bot): Promise<void> {
  const stop = Promise.withResolvers<void>();
  const signal = (name: string) => {
    log("service.signal", { signal: name });
    stop.resolve();
  };
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  return Promise.race([
    stop.promise,
    bot.harness.closed.then((end) => {
      if (end.reason === "failed") throw new Error("Agent session failed", { cause: end.error });
    }),
  ]).finally(() => {
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
  });
}

async function main(): Promise<void> {
  process.umask(0o077);
  const config = await loadConfig(configPath());
  const enabled = platforms(config);
  log("service.starting", { platforms: enabled.map((platform) => platform.name) });
  const bot = await Bot.open(config);
  try {
    for (const platform of enabled) await platform.start(bot.host(platform.name));
    console.log(
      `vidhan-bot ready; platforms: ${enabled.map((platform) => platform.name).join(", ")}; state: ${config.state_dir}`,
    );
    await waitForShutdown(bot);
  } finally {
    await Promise.allSettled(enabled.map((platform) => platform.stop()));
    await bot.close();
    log("service.stopped");
  }
}

main().catch((error: unknown) => {
  console.error("vidhan-bot failed", error);
  process.exitCode = 1;
});
