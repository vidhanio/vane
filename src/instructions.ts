import { section } from "@earendil-works/pi-durable";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function instructionSection() {
  return section("project_context", async (_input, context) => {
    const path = join(homedir(), "AGENTS.md");
    try {
      const content = await readFile(path, { encoding: "utf8", signal: context.abortSignal });
      return `Project-specific instructions and guidelines:\n\n<project_instructions path="${path}">\n${content}\n</project_instructions>`;
    } catch (error) {
      context.abortSignal?.throwIfAborted();
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  });
}
