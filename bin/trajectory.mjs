// Sanitized trajectory serialization from a Claude Code transcript JSONL.
// Port of pi-shadow-mind's trajectory.ts adapted to the Claude Code JSONL format:
//   - strip thinking blocks
//   - tool_use blocks -> "TOOL: name(args) · <summary>" (summary linked by tool_use_id)
//   - tool_result blocks -> "TOOL RESULT: <summary>"
//   - user text -> "USER:", assistant text -> "MAIN:", compaction summaries -> "SUMMARY:"
//   - sidechain (subagent) rows, attachments, mode/permission rows are skipped

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { summarizeToolResult } from "./summaries.mjs";

export const MAX_TRAJECTORY_CHARS = 200_000;

function isThinkingBlock(block) {
  return Boolean(block) && typeof block === "object" && block.type === "thinking";
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => Boolean(item) && typeof item === "object")
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function compactJson(value) {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

/** Summarize a tool_result block, using the tool name from the linked tool_use row. */
function summarizeToolResultBlock(block, toolName) {
  const isError = block && (block.isError === true || block.is_error === true);
  const content = block && (block.content ?? block.result);
  return summarizeToolResult({ isError, content, toolName });
}

/**
 * Stream a transcript JSONL and produce the sanitized trajectory text.
 * Fully tolerant: unknown rows/fields are skipped, trailing partial JSON lines are ignored,
 * and parsing errors never throw.
 *
 * @param {string} transcriptPath
 * @param {{ maxChars?: number, lastAssistantMessage?: string }} [options]
 */
export async function serializeTrajectory(transcriptPath, options = {}) {
  const maxChars = options.maxChars ?? MAX_TRAJECTORY_CHARS;

  // Pass 1: collect every row, the tool_use name map, and the tool_result summaries.
  const rows = [];
  const results = new Map(); // tool_use_id -> summary text
  const toolNames = new Map(); // tool_use_id -> tool name (needed since tool_result has no name)
  try {
    await forEachJsonLine(transcriptPath, (row) => {
      rows.push(row);
      if (!row || row.isSidechain === true) return;
      const content = row.message && row.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (row.type === "assistant" && block.type === "tool_use" && block.id && block.name) {
          toolNames.set(block.id, block.name);
        } else if (row.type === "user" && block.type === "tool_result") {
          const id = block.tool_use_id ?? block.toolUseId;
          const summary = summarizeToolResultBlock(block, id ? toolNames.get(id) : undefined);
          if (id) results.set(id, summary);
        }
      }
    });
  } catch {
    // Transcript unreadable is treated as an empty trajectory, not an error.
  }

  // Pass 2: emit sanitized lines.
  const lines = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (row.isSidechain === true) continue; // subagent rows must not leak into main trajectory
    if (row.type === "system") {
      const subtype = row.subtype ?? "";
      const compactable = /compact|summary/i.test(subtype) || Boolean(row.summary || row.summaryText);
      const text = compactable ? extractText(row.message?.content ?? row.summary ?? row.summaryText ?? "") : "";
      if (text) lines.push(`SUMMARY: ${text}`);
      continue;
    }
    if (row.type !== "assistant" && row.type !== "user") continue;

    const message = row.message;
    if (!message || typeof message !== "object") continue;
    const role = message.role;
    const content = message.content;

    if (role === "user") {
      if (typeof content === "string") {
        if (content.trim()) lines.push(`USER: ${content}`);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && block.text) lines.push(`USER: ${block.text}`);
          // tool_result blocks are represented on their TOOL: line (or standalone below)
        }
      }
    } else if (role === "assistant") {
      if (typeof content === "string") {
        if (content.trim()) lines.push(`MAIN: ${content}`);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object" || isThinkingBlock(block)) continue;
          if (block.type === "text" && block.text) {
            lines.push(`MAIN: ${block.text}`);
          } else if (block.type === "tool_use" && block.name) {
            const call = `${block.name}(${compactJson(block.input)})`;
            const summary = block.id ? results.get(block.id) : undefined;
            lines.push(summary ? `TOOL: ${call} · ${summary}` : `TOOL: ${call}`);
          }
        }
      }
    }
  }

  // last_assistant_message fallback: the transcript may not include the final message at Stop time.
  const lastAssistant = (options.lastAssistantMessage ?? "").trim();
  if (lastAssistant && !lines.some((line) => line.startsWith("MAIN:") && line.slice(5).includes(lastAssistant.slice(0, 40)))) {
    lines.push(`MAIN: ${lastAssistant}`);
  }

  let body = lines.join("\n");
  if (body.length > maxChars) body = `${body.slice(0, maxChars)}\n[trajectory truncated]`;
  return `<main-agent-trajectory>\n${body}\n</main-agent-trajectory>`;
}

/** Read a JSONL file line by line, parsing each row; skip broken lines. */
export async function forEachJsonLine(filePath, onRow) {
  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  let buffer = "";
  try {
    for await (const line of rl) {
      const text = line.trim();
      if (!text) continue;
      if (text.startsWith("{")) buffer = text;
      else if (buffer) buffer += text;
      else continue;
      if (!isCompleteJson(buffer)) continue;
      const row = JSON.parse(buffer);
      buffer = "";
      onRow(row);
    }
  } finally {
    rl.close();
  }
}

function isCompleteJson(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
  }
  return depth <= 0;
}