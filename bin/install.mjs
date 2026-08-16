// One-time global registration for the plugin.
// Writes ~/.claude/shadow-mind.json with { pluginDir, nodePath } so commands
// (/shadow) and hooks can resolve the plugin regardless of install location.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const pluginDir = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));
const nodePath = process.argv[3] ?? process.execPath;

// All paths are stored with forward slashes (Windows-safe for both cmd and node).
function normalizeToWindows(p) {
  return p.replace(/\\/g, "/");
}

const marker = {
  pluginDir: normalizeToWindows(pluginDir),
  nodePath: normalizeToWindows(nodePath),
  installedAt: new Date().toISOString(),
};

const target = join(homedir(), ".claude", "shadow-mind.json");
await writeFile(target, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
process.stdout.write(`Wrote ${target}\n${JSON.stringify(marker, null, 2)}\n`);