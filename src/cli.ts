#!/usr/bin/env bun

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Bot } from "./bot.ts";
import { loadConfig, type BotConfig } from "./config.ts";
import { Discord } from "./platforms/discord/index.ts";
import { log } from "./log.ts";

function configPath(): string {
  return resolve(
    process.env.VANE_CONFIG ??
      join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "vane/config.toml"),
  );
}

function platforms(config: BotConfig, bot: Bot): Discord[] {
  const entries = Object.entries(config.platforms);
  if (entries.length === 0)
    throw new Error("No platforms enabled; add a [platforms.<name>] table to the config");
  return entries.map(([name, raw]) => {
    if (name !== "discord") throw new Error(`Unknown platform: ${name}`);
    try {
      return new Discord(bot, raw, join(config.state_dir, "attachments", "discord"));
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
  const bot = await Bot.open(config);
  let enabled: Discord[] = [];
  try {
    enabled = platforms(config, bot);
    log("service.starting", { platforms: enabled.map((platform) => platform.name) });
    for (const platform of enabled) await platform.start();
    console.log(
      `vane ready; platforms: ${enabled.map((platform) => platform.name).join(", ")}; state: ${config.state_dir}`,
    );
    await waitForShutdown(bot);
  } finally {
    await Promise.allSettled([...enabled.map((platform) => platform.stop()), bot.session.close()]);
    try {
      await bot.close();
    } finally {
      await Promise.allSettled(enabled.map((platform) => platform.close()));
    }
    log("service.stopped");
  }
}

main().catch((error: unknown) => {
  console.error("vane failed", error);
  process.exitCode = 1;
});
