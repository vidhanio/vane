#!/usr/bin/env bun

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Bot } from "./bot.ts";
import { loadConfig, type BotConfig } from "./config.ts";
import { Discord } from "./platforms/discord/index.ts";
import type { Platform } from "./platforms/index.ts";
import { log } from "./log.ts";

function configPath(): string {
  return resolve(
    process.env.VANE_CONFIG ??
      join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "vane/config.toml"),
  );
}

function platforms(config: BotConfig, bot: Bot, resources: AsyncDisposableStack): Platform[] {
  const entries = Object.entries(config.platforms);
  if (entries.length === 0)
    throw new Error("No platforms enabled; add a [platforms.<name>] table to the config");
  return entries.map(([name, raw]) => {
    if (name !== "discord") throw new Error(`Unknown platform: ${name}`);
    try {
      const platform = new Discord(
        bot.session,
        raw,
        join(config.state_dir, "attachments", "discord"),
      );
      resources.defer(() => platform.close());
      return platform;
    } catch (error) {
      throw new Error(`Invalid [platforms.${name}] configuration`, { cause: error });
    }
  });
}

async function main(): Promise<void> {
  process.umask(0o077);
  await using resources = new AsyncDisposableStack();
  const shutdown = Promise.withResolvers<void>();
  const controller = new AbortController();
  const signal = (name: string) => {
    log("service.signal", { signal: name });
    controller.abort();
    shutdown.resolve();
  };
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  resources.defer(() => {
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
  });
  const config = await loadConfig(configPath());
  const bot = await Bot.open(config);
  await using connections = new AsyncDisposableStack();
  connections.defer(() => bot.close());
  const enabled = platforms(config, bot, resources);
  connections.defer(async () => {
    const settled = await Promise.allSettled([
      ...enabled.map((platform) => platform.stop()),
      bot.session.close(),
    ]);
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Session shutdown failed");
  });
  log("service.starting", { platforms: enabled.map((platform) => platform.name) });
  try {
    for (const platform of enabled) await platform.start(controller.signal);
    console.log(
      `vane ready; platforms: ${enabled.map((platform) => platform.name).join(", ")}; state: ${config.state_dir}`,
    );
    await Promise.race([
      shutdown.promise,
      bot.harness.closed.then((end) => {
        if (end.reason === "failed") throw new Error("Agent session failed", { cause: end.error });
      }),
    ]);
  } catch (error) {
    if (
      !controller.signal.aborted ||
      (error !== controller.signal.reason &&
        !(error instanceof Error && error.name === "AbortError"))
    )
      throw error;
  } finally {
    log("service.stopping");
  }
}

main()
  .then(() => log("service.stopped"))
  .catch((error: unknown) => {
    console.error("vane failed", error);
    process.exitCode = 1;
  });
