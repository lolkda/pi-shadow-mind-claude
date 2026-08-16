import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYaml, parseFrontmatter, serializeFrontmatter } from "../bin/frontmatter.mjs";

test("parses scalars", () => {
  assert.deepEqual(parseYaml("a: 1\nb: 2.5\nc: true\nd: false\ne: hello\nf: \"quoted: x\"\ng: 'single''quote'\nh: null"), {
    a: 1, b: 2.5, c: true, d: false, e: "hello", f: "quoted: x", g: "single'quote", h: null,
  });
});

test("parses inline arrays", () => {
  assert.deepEqual(parseYaml('ids: [a, b, "c,d", 3]'), { ids: ["a", "b", "c,d", 3] });
});

test("parses block lists", () => {
  assert.deepEqual(parseYaml("tools:\n  - read\n  - grep\n  - find"), { tools: ["read", "grep", "find"] });
});

test("empty value without list becomes null", () => {
  assert.deepEqual(parseYaml("key:"), { key: null });
});

test("throws on malformed line", () => {
  assert.throws(() => parseYaml("not-a-colon"), /key: value/);
});

test("throws on unterminated inline array", () => {
  assert.throws(() => parseYaml("ids: [a, b"), /unterminated inline array/);
});

test("parseFrontmatter extracts body and meta", () => {
  const source = "---\nid: foo\nname: Bar\n---\n\nDo the thing.";
  assert.deepEqual(parseFrontmatter(source), { meta: { id: "foo", name: "Bar" }, body: "Do the thing." });
});

test("parseFrontmatter returns null without fences", () => {
  assert.equal(parseFrontmatter("no frontmatter here"), null);
});

test("objectFrontmatter round-trips through serializeFrontmatter", () => {
  const source = "---\nid: x\nenabled: true\nactivation_probability: 0.3\ntools: [read, grep]\n---\n\nbody text";
  const parsed = parseFrontmatter(source);
  const serialized = serializeFrontmatter(parsed.meta, parsed.body);
  const reparsed = parseFrontmatter(serialized);
  assert.deepEqual(reparsed.meta, parsed.meta);
  assert.equal(reparsed.body, "body text");
});