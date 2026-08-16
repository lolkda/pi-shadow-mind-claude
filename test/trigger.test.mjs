import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { touchMatchingExt, normalizeExts } from "../bin/trigger.mjs";

const USER_MSG = { type: "user", message: { role: "user", content: [{ type: "text", text: "实现登录" }] } };
const toolUse = (name, input) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "c1", name, input }] } });

async function withTranscript(rows, run) {
  const dir = await mkdtemp(join(tmpdir(), "shadow-trigger-"));
  const path = join(dir, "transcript.jsonl");
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  try {
    return await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Write of a listed extension triggers", async () => {
  const rows = [USER_MSG, toolUse("Write", { file_path: "src/auth.py" })];
  const hit = await withTranscript(rows, (p) => touchMatchingExt(p, ["py"]));
  assert.equal(hit, true);
});

test("Edit of a listed extension is case-insensitive", async () => {
  const rows = [USER_MSG, toolUse("Edit", { file_path: "app/SERVER.TS" })];
  const hit = await withTranscript(rows, (p) => touchMatchingExt(p, ["ts"]));
  assert.equal(hit, true);
});

test("Bash mentioning the extension triggers", async () => {
  const rows = [USER_MSG, toolUse("Bash", { command: "python train.py" })];
  const hit = await withTranscript(rows, (p) => touchMatchingExt(p, ["py"]));
  assert.equal(hit, true);
});

test("Bash without the extension does not trigger", async () => {
  const rows = [USER_MSG, toolUse("Bash", { command: "ls -la" })];
  const hit = await withTranscript(rows, (p) => touchMatchingExt(p, ["py", "sh"]));
  assert.equal(hit, false);
});

test("read-only tools never trigger", async () => {
  const rows = [USER_MSG, toolUse("Read", { file_path: "a.py" }), toolUse("Grep", { pattern: "x", path: "b.py" })];
  const hit = await withTranscript(rows, (p) => touchMatchingExt(p, ["py"]));
  assert.equal(hit, false);
});

test("history before the last user instruction is outside the window", async () => {
  const rows = [
    toolUse("Write", { file_path: "old.java" }), // before the instruction
    USER_MSG,
    toolUse("Write", { file_path: "new.ts" }),
  ];
  const javaHit = await withTranscript(rows, (p) => touchMatchingExt(p, ["java"]));
  const tsHit = await withTranscript(rows, (p) => touchMatchingExt(p, ["ts"]));
  assert.equal(javaHit, false);
  assert.equal(tsHit, true);
});

test("extension not in the list does not trigger", async () => {
  const rows = [USER_MSG, toolUse("Write", { file_path: "notes.md" })];
  const hit = await withTranscript(rows, (p) => touchMatchingExt(p, ["py"]));
  assert.equal(hit, false);
});

test("missing transcript returns false", async () => {
  const hit = await touchMatchingExt("C:/no/such/transcript.jsonl", ["py"]);
  assert.equal(hit, false);
});

test("empty transcript returns false", async () => {
  const hit = await withTranscript([], (p) => touchMatchingExt(p, ["py"]));
  assert.equal(hit, false);
});

test("normalizeExts strips dots and lowercases", () => {
  assert.deepEqual(normalizeExts([".Py", "TS", ".ts", "sh"]), ["py", "ts", "sh"]);
});

test("NotebookEdit notebook_path triggers", async () => {
  const rows = [USER_MSG, toolUse("NotebookEdit", { notebook_path: "notebooks/eda.ipynb" })];
  const hit = await withTranscript(rows, (p) => touchMatchingExt(p, ["ipynb"]));
  assert.equal(hit, true);
});

test("read-only Bash commands do not trigger", async () => {
  for (const cmd of ["cat auth.py", "ls *.py", "grep -r foo ./*.py", "Get-Content x.ts"]) {
    const rows = [USER_MSG, toolUse("Bash", { command: cmd })];
    const hit = await withTranscript(rows, (p) => touchMatchingExt(p, ["py", "ts"]));
    assert.equal(hit, false, `expected no trigger for: ${cmd}`);
  }
});

test("executing Bash commands still trigger", async () => {
  for (const cmd of ["python train.py", "go run main.go", "npm run build.ts"]) {
    const rows = [USER_MSG, toolUse("Bash", { command: cmd })];
    const hit = await withTranscript(rows, (p) => touchMatchingExt(p, ["py", "go", "ts"]));
    assert.equal(hit, true, `expected trigger for: ${cmd}`);
  }
});
