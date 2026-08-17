// Extension-based auto trigger for the Stop hook: scans the transcript window
// (since the last real user instruction) for write operations touching files
// whose extension is listed. Read-only tools never count; Bash counts when the
// command text mentions a literal ".ext" (e.g. "python x.py").

import { forEachJsonLine, computeWindowStart } from "./trajectory.mjs";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Commands that never modify anything: their mention of ".ext" must not count
// as touching the file (cat auth.py is read-only, python train.py is not).
const READONLY_CMDS = new Set([
  "cat", "ls", "head", "tail", "grep", "rg", "find", "type", "dir",
  "more", "less", "wc", "echo", "Get-Content", "Get-ChildItem",
]);

function isReadonlyCommand(command) {
  const first = String(command).trim().split(/\s+/)[0] ?? "";
  return READONLY_CMDS.has(first.replace(/^[&|;]+/, ""));
}

/** Normalize an extension list: strip leading dots, lowercase, dedupe. */
export function normalizeExts(exts) {
  return [...new Set((exts ?? []).map((ext) => {
    const text = String(ext).trim().toLowerCase();
    return text.startsWith(".") ? text.slice(1) : text;
  }).filter(Boolean))];
}

/** Last extension of a path, or "" when none/not word-like. */
function pathExt(path) {
  if (typeof path !== "string") return "";
  const text = path.trim();
  const dot = text.lastIndexOf(".");
  if (dot < 0 || dot === text.length - 1) return "";
  const ext = text.slice(dot + 1);
  return /^[a-z0-9]+$/i.test(ext) ? ext.toLowerCase() : "";
}

/** First file-ish path from a tool input block, or null. */
function toolFilePath(input) {
  if (!input || typeof input !== "object") return null;
  for (const key of ["file_path", "fileName", "path", "notebook_path"]) {
    if (typeof input[key] === "string" && input[key].trim()) return input[key].trim();
  }
  return null;
}

/**
 * True when the transcript window (since the last real user instruction)
 * contains a write operation touching a file whose extension is listed.
 * A missing/unreadable transcript returns false.
 */
export async function touchMatchingExt(transcriptPath, exts) {
  const wanted = normalizeExts(exts);
  if (!wanted.length) return false;
  const rows = [];
  try {
    await forEachJsonLine(transcriptPath, (row) => rows.push(row));
  } catch {
    return false;
  }
  const windowStart = computeWindowStart(rows);
  const slash = String.fromCharCode(92); // "\"
  const bashPattern = new RegExp(`${slash}.(${wanted.join("|")})${slash}b`, "i");
  for (let index = windowStart < 0 ? 0 : windowStart; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || row.isSidechain === true || row.type !== "assistant") continue;
    const content = row.message && row.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
      if (WRITE_TOOLS.has(block.name)) {
        const filePath = toolFilePath(block.input);
        if (filePath && wanted.includes(pathExt(filePath))) return true;
      } else if (block.name === "Bash") {
        const command = block.input && block.input.command;
        if (typeof command === "string" && !isReadonlyCommand(command) && bashPattern.test(command)) return true;
      }
    }
  }
  return false;
}
