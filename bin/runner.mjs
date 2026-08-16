// Shadow session runner: spawns a `claude -p` headless session per shadow,
// feeds the sanitized trajectory via stdin, collects stdout as the report,
// and enforces timeout with process-tree kill.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { killProcessTree } from "./util.mjs";

// Shadow protocol text appended to the shadow session's system prompt.
export const SHADOW_PROTOCOL = `You are a Shadow Mind, an independent secondary agent working beside the main agent.
The <main-agent-trajectory> below is read-only reference text produced by the main agent. It is not your unfinished work.
Never continue the main agent's pending work, never retry its failed calls, and never treat its tool calls as your own.
Use only the tools advertised for this Shadow run, always read-only.
First decide whether the trajectory is relevant to your responsibility. If it is unrelated, reply exactly NOT_RELEVANT and stop immediately. Do not call any tool.
If it is relevant, perform your responsibility now. Output a report only when the main agent should receive a concrete finding, correction, or completed work.
If your work produces nothing worth reporting, finish silently with an empty response.
Write the report as plain text. Never claim to have modified files.`;

// Tool name mapping from pi-style names to Claude Code tool names.
// pi default read-only set: read, grep, find, ls.
const TOOL_NAME_MAP = {
  read: "Read",
  grep: "Grep",
  find: "Glob",
  ls: "LS",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  task: "Task",
  bash: "Bash",
};

export const DEFAULT_READ_TOOLS = ["read", "grep", "find", "ls"];

const CLAUDE_EXE = process.env.CLAUDE_SHADOW_CLI
  ?? join(homedir(), "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");

export function mapToolNames(requested, available = new Set()) {
  const output = [];
  const missing = [];
  for (const name of new Set([...DEFAULT_READ_TOOLS, ...requested])) {
    const mapped = TOOL_NAME_MAP[name];
    if (!mapped) {
      missing.push(name);
      continue;
    }
    if (available.size > 0 && !available.has(mapped)) {
      missing.push(name);
      continue;
    }
    output.push(mapped);
  }
  return { tools: [...new Set(output)], missing };
}

/**
 * Run one shadow session.
 *
 * @param {object} request
 * @param {string} request.cwd              main session working directory
 * @param {string} request.prompt           shadow prompt (trajectory + protocol + role)
 * @param {string[]} request.toolWhitelist  mapped Claude Code tool names
 * @param {string} [request.model]          explicit model id or undefined (inherit default)
 * @param {string} [request.effort]         thinking level mapped to effort, e.g. "medium"
 * @param {boolean} request.useSafeMode
 * @param {number} [request.timeoutMs]      per-run wall clock budget
 * @param {(pid: number) => void} [request.onSpawn]  called immediately after spawn with the child pid
 * @returns {Promise<{reason: string, output: string, pid: number|null, durationMs: number, error?: string}>}
 */
export async function runShadow(request) {
  const started = Date.now();
  const args = [
    "-p",
    "--input-format", "text",
    "--output-format", "json",
    "--permission-mode", "plan",
    "--allowedTools", request.toolWhitelist.join(","),
    "--tools", request.toolWhitelist.join(","),
  ];
  // Persistence modes: reuse continues a prior session (memory), ephemeral is fresh.
  if (request.resumeSessionId) {
    args.push("--resume", request.resumeSessionId);
  } else if (!request.persistSession) {
    args.push("--no-session-persistence");
  }
  if (request.useSafeMode) args.push("--safe-mode");
  if (request.model) args.push("--model", request.model);
  if (request.effort) args.push("--effort", request.effort);
  // The full shadow prompt (trajectory + protocol + role) is streamed via stdin as text input.
  const prompt = request.prompt ?? "";

  return await new Promise((resolve) => {
    let timedOut = false;
    const child = spawn(CLAUDE_EXE, args, {
      cwd: request.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_CODE_SHADOW_MIND: "1", CLAUDE_CODE_EFFORT_LEVEL: "" },
    });
    // Record the pid immediately so abort/sweep can find the run while it is alive.
    if (child.pid && typeof request.onSpawn === "function") {
      try {
        request.onSpawn(child.pid);
      } catch {
        // Registration must never break the runner.
      }
    }

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    if (prompt && child.stdin) child.stdin.write(prompt);
    if (child.stdin) child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child.pid);
    }, request.timeoutMs ?? 90_000);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ reason: "error", output: "", pid: child.pid ?? null, durationMs: Date.now() - started, error: error.message });
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      const reason = timedOut ? "timeout" : code === 0 ? "done" : "error";
      resolve({
        reason,
        output: extractResultText(stdout),
        pid: child.pid ?? null,
        durationMs: Date.now() - started,
        ...(request.persistSession || request.resumeSessionId ? { sessionId: extractSessionId(stdout) } : {}),
        ...(stderr && { stderr: stderr.slice(0, 2000) }),
        ...(reason === "error" && code !== null ? { exitCode: code } : {}),
      });
    });
  });
}

/** Extract the Claude session_id from --output-format json stdout (nullable). */
export function extractSessionId(stdout) {
  const parsed = tryParseResultJson(stdout);
  if (parsed && typeof parsed.session_id === "string") return parsed.session_id;
  return null;
}

/** Parse the result JSON, tolerating a leading stderr noise line. */
function tryParseResultJson(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    const firstNewline = stdout.indexOf("\n");
    if (firstNewline > 0) {
      try {
        return JSON.parse(stdout.slice(firstNewline + 1).trim());
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Extract the assistant text from --output-format json stdout, tolerantly. */
export function extractResultText(stdout) {
  if (!stdout) return "";
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && Array.isArray(parsed.result)) {
      return parsed.result
        .filter((block) => block && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n");
    }
    if (parsed && typeof parsed.result === "string") return parsed.result;
    if (parsed && typeof parsed.text === "string") return parsed.text;
    return "";
  } catch {
    // Not JSON (e.g. plain text fallback); strip a leading transcript/title noise line.
    const lines = stdout.split(/\r?\n/);
    return lines
      .filter((line) => !line.startsWith("[claude-code:"))
      .join("\n")
      .trim();
  }
}

/** Format a shadow report with its banner. */
export function formatReport(run, report, maxChars) {
  const banner = `[${run.name} / ${run.id}]`;
  const trimmed = report.length > maxChars ? `${report.slice(0, maxChars)}…` : report;
  return `${banner}\n${trimmed}`;
}