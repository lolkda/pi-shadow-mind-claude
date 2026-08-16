// Shared helpers: stdin JSON reading, logging to stderr/file, process tree kill.
// Hooks MUST never write to stdout except the final JSON (or nothing).

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Read all of stdin as utf8, then JSON.parse. Never throws (returns null on any failure). */
export async function readStdinJson() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8").trim();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    console.error(`[shadow-mind] stdin parse failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Append a log line to the debug log file (never stdout). */
export function logDebug(stateDir, line) {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, "shadow-debug.log"), `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    // Logging must never break the hook.
  }
}

/** Kill a process tree on Windows (taskkill /T /F). Resolves false on spawn error, true otherwise. */
export function killProcessTree(pid) {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("exit", () => resolve(true));
  });
}

/** True if a pid is alive (Windows-safe: process.kill(pid, 0) probe). */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}