import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

export const pathSchema = z
  .string()
  .min(1)
  .transform((value) => resolve(value.replace(/^~(?=\/|$)/, homedir())));

const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Configuration shared by every platform, owned by the bot. */
const botConfigSchema = z.strictObject({
  state_dir: pathSchema.default(
    join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "vane"),
  ),
  agent_socket: pathSchema.optional(),
  /** Platform tables, keyed by platform name. Each platform parses its own. */
  platforms: z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/), z.unknown()).default({}),
  memory: z
    .strictObject({
      provider: z.string().min(1).default("anthropic"),
      model_id: z.string().min(1).default("claude-haiku-4-5"),
      thinking: thinkingSchema.default("xhigh"),
    })
    .prefault({}),
  agent: z.strictObject({
    provider: z.string().min(1),
    model_id: z.string().min(1),
    thinking: thinkingSchema.default("medium"),
    cwd: pathSchema.default("/tmp"),
  }),
});
export type BotConfig = z.infer<typeof botConfigSchema>;

export async function loadConfig(file: string): Promise<BotConfig> {
  const config = botConfigSchema.parse(expandEnvironment(parse(await Bun.file(file).text())));
  if (!(await stat(config.agent.cwd)).isDirectory())
    throw new Error(`Not a directory: ${config.agent.cwd}`);
  return config;
}

/** Expand explicit placeholders after TOML parsing, never by rewriting TOML source. */
function expandEnvironment(value: unknown): unknown {
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
