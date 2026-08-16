import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { serializeTrajectory, MAX_TRAJECTORY_CHARS } from "../bin/trajectory.mjs";
import { summarizeToolResult } from "../bin/summaries.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/main-session.jsonl", import.meta.url));

test("windows to the most recent user request", async () => {
  const out = await serializeTrajectory(FIXTURE);
  assert.ok(out.startsWith("<main-agent-trajectory>\n"));
  assert.ok(out.endsWith("</main-agent-trajectory>"));
  // window starts at the last real USER message
  assert.ok(out.includes("USER: 再加个测试文件"));
  assert.ok(out.startsWith("<main-agent-trajectory>\nUSER: 再加个测试文件"));
  // the current turn's agent work is present
  assert.ok(out.includes("TOOL: Grep({"));
  assert.ok(out.includes("2 entries · split.js"));
  assert.ok(out.includes("MAIN: 测试文件已加好，函数在 split.js"));
  // older turns and their tool chatter are dropped
  assert.ok(!out.includes("USER: 写一个按逗号拆分的函数到 split.js"));
  assert.ok(!out.includes('TOOL: Write({"file_path":"split.js"'));
  assert.ok(!out.includes("MAIN: 我来写这个函数。"));
  // thinking stripped
  assert.ok(!out.includes("让我先想一下"));
  // sidechain assistant text must be filtered
  assert.ok(!out.includes("文件已创建，请看 split.js"));
  // sidechain user must be filtered
  assert.ok(!out.includes("子任务完成了吗"));
});

test("last_assistant_message fallback appends missing MAIN", async () => {
  const out = await serializeTrajectory(FIXTURE, { lastAssistantMessage: "最后一条助手消息落盘" });
  assert.ok(out.includes("MAIN: 最后一条助手消息落盘"));
});

test("last_assistant_message not duplicated when already present", async () => {
  const out = await serializeTrajectory(FIXTURE, { lastAssistantMessage: "测试文件已加好，函数在 split.js" });
  const count = (out.match(/测试文件已加好，函数在 split.js/g) ?? []).length;
  assert.equal(count, 1);
});

test("missing file yields empty (not thrown) trajectory", async () => {
  const out = await serializeTrajectory("C:/definitely/missing.jsonl", {});
  assert.equal(out.trim(), "<main-agent-trajectory>\n\n</main-agent-trajectory>");
});

test("respects maxChars truncation", async () => {
  const out = await serializeTrajectory(FIXTURE, { maxChars: 60 });
  assert.ok(out.includes("[earlier trajectory truncated]"));
});

test("module exposes a cap constant", () => {
  assert.ok(MAX_TRAJECTORY_CHARS > 0);
});

test("summaries produce deterministic counts", () => {
  assert.equal(summarizeToolResult({ toolName: "Read", content: [{ type: "text", text: "a\nb\nc" }] }), "3 entries · a");
  assert.equal(summarizeToolResult({ toolName: "Grep", content: "match one" }), "1 entries · match one");
  assert.equal(summarizeToolResult({ toolName: "Read", content: [] }), "0 entries");
  assert.equal(summarizeToolResult({ toolName: "Weird", content: null }), "null");
  assert.equal(summarizeToolResult({ toolName: "Read", isError: true, content: "boom" }), "error · 1 entries · boom");
});