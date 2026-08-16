import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, validateConfig } from "../bin/config.mjs";

test("defaults when empty", () => {
  const config = validateConfig({});
  assert.equal(config.heartbeat_probability, 1 / 3);
  assert.equal(config.max_parallel_shadows, 2);
  assert.equal(config.default_thinking_level, "medium");
  assert.equal(config.max_wait_ms, 90000);
  assert.equal(config.use_safe_mode, true);
});

test("accepts full valid config", () => {
  const config = validateConfig({
    heartbeat_probability: 0.5,
    max_parallel_shadows: 3,
    default_shadow_timeout_seconds: 120,
    default_shadow_model: "deepseek-v4-flash",
    default_thinking_level: "low",
    random_seed: 42,
    max_wait_ms: 60000,
    max_report_chars: 2000,
    max_trajectory_chars: 100000,
    use_safe_mode: false,
    daily_budget_usd: 1.5,
    report_delivery: "block",
  });
  assert.equal(config.max_parallel_shadows, 3);
  assert.equal(config.daily_budget_usd, 1.5);
  assert.equal(config.report_delivery, "block");
});

test("rejects out-of-range probability", () => {
  assert.throws(() => validateConfig({ heartbeat_probability: 1.5 }), /between 0 and 1/);
  assert.throws(() => validateConfig({ heartbeat_probability: -0.1 }), /between 0 and 1/);
});

test("rejects negative timeout and non-integer parallel", () => {
  assert.throws(() => validateConfig({ default_shadow_timeout_seconds: 0 }), /positive/);
  assert.throws(() => validateConfig({ max_parallel_shadows: 2.5 }), /integer/);
});

test("rejects bad thinking level", () => {
  assert.throws(() => validateConfig({ default_thinking_level: "ultra" }), /invalid/);
});

test("rejects bad daily budget", () => {
  assert.throws(() => validateConfig({ daily_budget_usd: -1 }), /non-negative/);
});

test("normalizes to defaults for legacy fields", () => {
  const config = validateConfig({ headless_drain_timeout_seconds: 60, result_batch_window_ms: 400 });
  assert.equal(config.headless_drain_timeout_seconds, 60);
  assert.ok(config.max_wait_ms > 0);
});

test("DEFAULT_CONFIG validates cleanly", () => {
  assert.doesNotThrow(() => validateConfig(DEFAULT_CONFIG));
});