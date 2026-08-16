// Resolve the main session's model id for active_for_models matching.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Best-effort model id resolution: env ANTHROPIC_MODEL > ~/.claude/settings.json "model".
 * @returns {string | undefined}
 */
export async function resolveMainModelId() {
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  try {
    const settings = JSON.parse(await readFile(join(homedir(), ".claude", "settings.json"), "utf8"));
    if (typeof settings.model === "string" && settings.model.trim()) return settings.model.trim();
  } catch {
    // Fall through.
  }
  return undefined;
}