import { test } from "node:test";
import assert from "node:assert/strict";
import { mapToolNames, formatReport, extractResultText, extractSessionId, DEFAULT_READ_TOOLS } from "../bin/runner.mjs";

test("maps pi tool names to Claude Code names", () => {
  const { tools, missing } = mapToolNames(["read", "grep", "ls", "webfetch", "nonexistent_tool"]);
  // Default read-only set (read,grep,find,ls) is always merged in: find -> Glob.
  assert.deepEqual(tools, ["Read", "Grep", "Glob", "LS", "WebFetch"]);
  assert.deepEqual(missing, ["nonexistent_tool"]);
});

test("defaults read-only tools always present", () => {
  const { tools } = mapToolNames([]);
  for (const expected of ["Read", "Grep", "Glob", "LS"]) {
    assert.ok(tools.includes(expected), `missing ${expected}`);
  }
});

test("bash only allowed when explicitly requested", () => {
  const { tools } = mapToolNames(["bash"]);
  assert.ok(tools.includes("Bash"));
  const without = mapToolNames([]);
  assert.ok(!without.tools.includes("Bash"));
});

test("DEFAULT_READ_TOOLS matches pi default", () => {
  assert.deepEqual(DEFAULT_READ_TOOLS, ["read", "grep", "find", "ls"]);
});

test("formatReport adds banner and truncates", () => {
  const out = formatReport({ name: "Code Reviewer", id: "code-reviewer" }, "a".repeat(100), 50);
  const banner = "[Code Reviewer / code-reviewer]\n";
  assert.ok(out.startsWith(banner));
  assert.equal(out.length, banner.length + 50 + 1); // 50 chars + truncation ellipsis
  assert.ok(out.endsWith("…"));
});

test("extractResultText parses JSON result array", () => {
  const out = extractResultText(JSON.stringify({
    result: [
      { type: "text", text: "hello" },
      { type: "other", text: "ignored" },
    ],
  }));
  assert.equal(out, "hello");
});

test("extractResultText falls back to plain text stripping noise lines", () => {
  const out = extractResultText("[claude-code:unrecognized_model] x\n报告内容");
  assert.equal(out.trim(), "报告内容");
});

test("extractResultText ignores empty output", () => {
  assert.equal(extractResultText(""), "");
});

test("extractSessionId parses result JSON", () => {
  const out = extractSessionId(JSON.stringify({ session_id: "abc-123", result: "ok" }));
  assert.equal(out, "abc-123");
});

test("extractSessionId tolerates a leading noise line", () => {
  const out = extractSessionId(`[claude-code:unrecognized_model] x\n${JSON.stringify({ session_id: "sid-9", result: "ok" })}`);
  assert.equal(out, "sid-9");
});

test("extractSessionId returns null on garbage or empty", () => {
  assert.equal(extractSessionId(""), null);
  assert.equal(extractSessionId("not json at all"), null);
});