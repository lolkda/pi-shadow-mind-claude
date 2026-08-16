import { test } from "node:test";
import assert from "node:assert/strict";
import { createRandom, decideHeartbeat, matchesModel, normalizeModelId } from "../bin/scheduler.mjs";

const shadow = (id, probability = 0.3, options = {}) => ({
  id, name: id, enabled: options.enabled ?? true,
  activationProbability: probability,
  activeForModels: options.activeForModels ?? ["*"],
  prompt: "", filePath: `C:/x/${id}.md`, tools: [],
});

test("seeded RNG is deterministic", () => {
  const a = createRandom(42);
  const b = createRandom(42);
  const seqA = Array.from({ length: 100 }, () => a());
  const seqB = Array.from({ length: 100 }, () => b());
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((value) => value >= 0 && value < 1));
});

test("seeded and unseeded differ", () => {
  const seeded = createRandom(7);
  assert.equal(seeded(), createRandom(7)());
  assert.notEqual(seeded(), createRandom(8)());
});

test("matchesModel handles [1M]/[1m] normalization", () => {
  const s = shadow("x", 0.3, { activeForModels: ["deepseek-v4-flash[1m]"] });
  assert.ok(matchesModel(s, normalizeModelId("deepseek-v4-flash[1M]")));
  const any = shadow("y", 0.3, { activeForModels: ["*"] });
  assert.ok(matchesModel(any, "anything"));
});

test("matchesModel normalizes the shadow's own declared model ids", () => {
  // User writes [1M] uppercase in active_for_models; main model id is normalized to [1m].
  const s = shadow("x", 0.3, { activeForModels: ["deepseek-v4-flash[1M]"] });
  assert.ok(matchesModel(s, normalizeModelId("deepseek-v4-flash[1M]")));
  assert.ok(matchesModel(s, "deepseek-v4-flash[1M]"));
  const unrelated = shadow("y", 0.3, { activeForModels: ["claude-sonnet-5"] });
  assert.ok(!matchesModel(unrelated, "deepseek-v4-flash[1m]"));
});

test("heartbeat below threshold activates nothing", () => {
  const result = decideHeartbeat({
    heartbeatProbability: 1,
    availableSlots: 2,
    shadows: [shadow("a", 0.3)],
    activeShadowIds: new Set(),
    mainModelId: "m",
    random: () => 0.9, // heartbeat roll 0.9 >= 1? no -> heartbeat rolls: 0.9 < 1 => heartbeat fires
  });
  // random() returns 0.9 for heartbeat; then per-shadow roll also 0.9 -> no activation hit.
  assert.equal(result.heartbeatRoll, 0.9);
  assert.equal(result.activated.length, 0);
});

test("probability 1 activates every eligible shadow up to slots", () => {
  const result = decideHeartbeat({
    heartbeatProbability: 1,
    availableSlots: 2,
    shadows: [shadow("a", 1), shadow("b", 1), shadow("c", 1)],
    activeShadowIds: new Set(),
    mainModelId: "m",
    random: () => 0.1,
  });
  assert.equal(result.activated.length, 2); // slots cap at 2
  assert.equal(result.candidates.length, 3);
});

test("running shadows excluded", () => {
  const result = decideHeartbeat({
    heartbeatProbability: 1,
    availableSlots: 2,
    shadows: [shadow("a", 1), shadow("b", 1)],
    activeShadowIds: new Set(["a"]),
    mainModelId: "m",
    random: () => 0.1,
  });
  assert.deepEqual(result.runningExcluded, ["a"]);
  assert.deepEqual(result.activated.map(({ shadow }) => shadow.id), ["b"]);
});

test("model mismatch filtered", () => {
  const result = decideHeartbeat({
    heartbeatProbability: 1,
    availableSlots: 2,
    shadows: [shadow("a", 1, { activeForModels: ["other-model"] }), shadow("b", 1)],
    activeShadowIds: new Set(),
    mainModelId: "main-model-here",
    random: () => 0.1,
  });
  assert.deepEqual(result.modelFiltered, ["a"]);
  assert.deepEqual(result.activated.map(({ shadow }) => shadow.id), ["b"]);
});

test("no slots means no heartbeat", () => {
  const result = decideHeartbeat({
    heartbeatProbability: 1,
    availableSlots: 0,
    shadows: [shadow("a", 1)],
    activeShadowIds: new Set(),
    mainModelId: "m",
    random: () => 0.1,
  });
  assert.equal(result.activated.length, 0);
});

test("disabled shadows never activate", () => {
  const result = decideHeartbeat({
    heartbeatProbability: 1,
    availableSlots: 2,
    shadows: [shadow("a", 1, { enabled: false })],
    activeShadowIds: new Set(),
    mainModelId: "m",
    random: () => 0.1,
  });
  assert.equal(result.activated.length, 0);
  assert.equal(result.candidates.length, 0);
});