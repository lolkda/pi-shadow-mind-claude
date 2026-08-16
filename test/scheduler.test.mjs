import { test } from "node:test";
import assert from "node:assert/strict";
import { FORCE_TTL_MS, forceTriggerValid } from "../bin/scheduler.mjs";

test("fresh force trigger is valid", () => {
  assert.equal(forceTriggerValid({ id: "*", at: Date.now() }), true);
});

test("expired force trigger is invalid", () => {
  assert.equal(forceTriggerValid({ id: "*", at: Date.now() - FORCE_TTL_MS - 1 }), false);
});

test("trigger without timestamp is valid (legacy)", () => {
  assert.equal(forceTriggerValid({ id: "*" }), true);
});

test("null or undefined trigger is invalid", () => {
  assert.equal(forceTriggerValid(null), false);
  assert.equal(forceTriggerValid(undefined), false);
});

test("injectable clock participates", () => {
  const now = 1_000_000;
  assert.equal(forceTriggerValid({ id: "*", at: now - FORCE_TTL_MS }, now), true);
  assert.equal(forceTriggerValid({ id: "*", at: now - FORCE_TTL_MS - 1 }, now), false);
});
