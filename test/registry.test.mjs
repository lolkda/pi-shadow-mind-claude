import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShadowMarkdown } from "../bin/registry.mjs";

const VALID = `---
id: code-reviewer
name: Code Reviewer
enabled: true
debug: false
active_for_models: ["*"]
tools: [read, grep]
---
Review the code.

Focus on unsafe patterns.
`;

test("parses valid shadow definition", () => {
  const shadow = parseShadowMarkdown(VALID, "C:/x/code-reviewer.md");
  assert.equal(shadow.id, "code-reviewer");
  assert.equal(shadow.name, "Code Reviewer");
  assert.deepEqual(shadow.activeForModels, ["*"]);
  assert.deepEqual(shadow.tools, ["read", "grep"]);
  assert.ok(shadow.prompt.includes("Review the code."));
  assert.ok(shadow.prompt.includes("unsafe patterns"));
});

test("defaults from filename id when id missing", () => {
  const shadow = parseShadowMarkdown("---\nname: X\n---\nbody", "C:/x/my-shadow.md");
  assert.equal(shadow.id, "my-shadow");
  assert.equal(shadow.name, "X");
});

test("defaults enabled=true", () => {
  const shadow = parseShadowMarkdown("---\nid: a\n---\nbody", "C:/x/a.md");
  assert.equal(shadow.enabled, true);
});

test("throws on missing frontmatter", () => {
  assert.throws(() => parseShadowMarkdown("plain text", "C:/x/a.md"), /missing YAML frontmatter/);
});

test("throws on empty body", () => {
  assert.throws(() => parseShadowMarkdown("---\nid: a\n---\n   ", "C:/x/a.md"), /prompt body is empty/);
});

test("parses persistence field", () => {
  const p = parseShadowMarkdown("---\nid: a\npersistence: reuse\n---\nbody", "C:/x/a.md");
  assert.equal(p.persistence, "reuse");
  const d = parseShadowMarkdown("---\nid: b\n---\nbody", "C:/x/b.md");
  assert.equal(d.persistence, undefined);
  assert.throws(() => parseShadowMarkdown("---\nid: c\npersistence: bogus\n---\nbody", "C:/x/c.md"), /must be one of/);
});

test("serialize round-trips persistence", async () => {
  const { ShadowRegistry } = await import("../bin/registry.mjs");
  const registry = new ShadowRegistry();
  const parsed = parseShadowMarkdown("---\nid: mem\npersistence: reuse\n---\nbody", "C:/x/mem.md");
  const reparsed = parseShadowMarkdown(registry.serialize(parsed), "C:/x/mem.md");
  assert.equal(reparsed.persistence, "reuse");
});

test("throws on invalid id pattern", () => {
  assert.throws(() => parseShadowMarkdown("---\nid: Bad Id!\n---\nbody", "C:/x/a.md"), /id must match/);
});

test("serialize round-trips", async () => {
  const { ShadowRegistry } = await import("../bin/registry.mjs");
  const registry = new ShadowRegistry();
  const parsed = parseShadowMarkdown(VALID, "C:/x/code-reviewer.md");
  const source = registry.serialize(parsed);
  const again = parseShadowMarkdown(source, "C:/x/code-reviewer.md");
  assert.equal(again.id, parsed.id);
  assert.equal(again.name, parsed.name);
  assert.deepEqual(again.tools, parsed.tools);
  assert.ok(again.prompt.includes("unsafe patterns"));
});