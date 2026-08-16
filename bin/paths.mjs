// Central path resolution for the plugin.
// All state lives under ~/.claude/shadow-minds/ so the plugin dir stays read-only
// (one copy can be shared via marketplace).

import { homedir } from "node:os";
import { join } from "node:path";

/** Where runtime state (config.json, state.json, shadow definitions, logs) lives. */
export const agentDir = join(homedir(), ".claude", "shadow-minds");

export const configPath = join(agentDir, "config.json");
export const statePath = join(agentDir, "state.json");
export const shadowDir = agentDir;
export const debugLogPath = join(agentDir, "shadow-debug.log");