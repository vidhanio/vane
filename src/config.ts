import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

export const pathSchema = z
  .string()
  .min(1)
  .transform((value) => resolve(value.replace(/^~(?=\/|$)/, homedir())));

/** Configuration shared by every platform, owned by the bot. */
export const botConfigSchema = z.strictObject({
  state_dir: pathSchema.default(join(homedir(), ".local/state/vidhan-bot")),
  herdr_socket: pathSchema.default(
    process.env.HERDR_SOCKET_PATH ??
      join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "herdr",
        ...(process.env.HERDR_SESSION ? ["sessions", process.env.HERDR_SESSION] : []),
        "herdr.sock",
      ),
  ),
  /** Platform tables, keyed by platform name. Each platform parses its own. */
  platforms: z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/), z.unknown()).default({}),
  agent: z.strictObject({
    provider: z.string().min(1),
    model_id: z.string().min(1),
    thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).default("medium"),
    cwd: pathSchema,
    instructions: z.string().default(""),
  }),
});
export type BotConfig = z.infer<typeof botConfigSchema>;

export async function validateBotConfig(input: unknown): Promise<BotConfig> {
  const config = botConfigSchema.parse(input);
  if (!(await stat(config.agent.cwd)).isDirectory())
    throw new Error(`Not a directory: ${config.agent.cwd}`);
  return config;
}

export async function loadConfig(file: string): Promise<BotConfig> {
  return validateBotConfig(expandEnvironment(parse(await Bun.file(file).text())));
}

/** Expand explicit placeholders after TOML parsing, never by rewriting TOML source. */
export function expandEnvironment(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => {
      const secret = process.env[name];
      if (!secret) throw new Error(`Missing environment variable ${name}`);
      return secret;
    });
  }
  if (Array.isArray(value)) return value.map(expandEnvironment);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandEnvironment(item)]),
    );
  return value;
}
