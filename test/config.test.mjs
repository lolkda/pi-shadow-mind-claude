import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, validateConfig } from "../bin/config.mjs";

test("defaults when empty", () => {
  const config = validateConfig({});
  assert.equal(config.default_thinking_level, "medium");
  assert.equal(config.default_shadow_timeout_seconds, 300);
  assert.equal(config.max_trajectory_chars, null);
  assert.equal(config.use_safe_mode, true);
  assert.equal(config.shadow_persistence, "reuse");
  assert.equal(config.max_resume_turns, 20);
});

test("accepts ephemeral persistence override", () => {
  const config = validateConfig({ shadow_persistence: "ephemeral" });
  assert.equal(config.shadow_persistence, "ephemeral");
});

test("rejects invalid persistence value", () => {
  assert.throws(() => validateConfig({ shadow_persistence: "bogus" }), /must be "ephemeral" or "reuse"/);
});

test("accepts full valid config", () => {
  const config = validateConfig({
    default_shadow_timeout_seconds: 120,
    default_shadow_model: "deepseek-v4-flash",
    default_thinking_level: "low",
    max_report_chars: 2000,
    max_trajectory_chars: 100000,
    use_safe_mode: false,
    report_delivery: "block",
  });
  assert.equal(config.report_delivery, "block");
});

test("rejects negative timeout", () => {
  assert.throws(() => validateConfig({ default_shadow_timeout_seconds: 0 }), /positive/);
});

test("rejects bad thinking level", () => {
  assert.throws(() => validateConfig({ default_thinking_level: "ultra" }), /invalid/);
});

test("normalizes to defaults for legacy fields", () => {
  const config = validateConfig({ headless_drain_timeout_seconds: 60, result_batch_window_ms: 400 });
  assert.equal(config.headless_drain_timeout_seconds, 60);
  assert.equal(config.default_shadow_timeout_seconds, 300);
});

test("DEFAULT_CONFIG validates cleanly", () => {
  assert.doesNotThrow(() => validateConfig(DEFAULT_CONFIG));
});