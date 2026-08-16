// Heartbeat scheduler. Port of pi-shadow-mind's scheduler.ts (mulberry32 PRNG).

/** Create a reproducible PRNG (mulberry32). */
export function createRandom(seed) {
  if (seed === undefined) return Math.random;
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

export function matchesModel(shadow, fullModelId) {
  if (shadow.activeForModels.includes("*")) return true;
  const normalized = normalizeModelId(fullModelId);
  return shadow.activeForModels.some((candidate) => normalizeModelId(candidate) === normalized);
}

/**
 * Decide whether a heartbeat fires and which shadows activate.
 * Mirrors pi-shadow-mind's decideHeartbeat.
 */
export function decideHeartbeat({
  heartbeatProbability,
  availableSlots,
  shadows,
  activeShadowIds,
  mainModelId,
  random = Math.random,
}) {
  const heartbeatRoll = random();
  if (heartbeatRoll >= heartbeatProbability || availableSlots <= 0) {
    return { heartbeatRoll, activated: [], candidates: [], modelFiltered: [], runningExcluded: [] };
  }

  const modelFiltered = [];
  const runningExcluded = [];
  const rolls = shadows
    .filter((shadow) => {
      if (!shadow.enabled) return false;
      if (activeShadowIds.has(shadow.id)) {
        runningExcluded.push(shadow.id);
        return false;
      }
      if (!matchesModel(shadow, mainModelId)) {
        modelFiltered.push(shadow.id);
        return false;
      }
      return true;
    })
    .map((shadow) => ({ shadow, roll: random() }));
  const hits = rolls.filter(({ shadow, roll }) => roll < shadow.activationProbability);
  const selected = sample(hits, Math.min(availableSlots, hits.length), random);
  const selectedIds = new Set(selected.map(({ shadow }) => shadow.id));
  return {
    heartbeatRoll,
    activated: selected,
    candidates: rolls.map(({ shadow, roll }) => ({ shadowId: shadow.id, roll, selected: selectedIds.has(shadow.id) })),
    modelFiltered,
    runningExcluded,
  };
}

function sample(values, count, random) {
  if (values.length <= count) return values;
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy.slice(0, count);
}

/** Normalize a model id for comparison: lowercase + strip whitespace. */
export function normalizeModelId(id) {
  return String(id ?? "").toLowerCase().replace(/\s+/g, "");
}