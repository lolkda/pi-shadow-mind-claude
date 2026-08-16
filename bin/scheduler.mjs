// Model filtering helpers for shadow activation (manual "/shadow now" trigger).
// Former heartbeat scheduler (decideHeartbeat / mulberry32 PRNG) was removed
// in favor of explicit-only activation.

export function matchesModel(shadow, fullModelId) {
  if (shadow.activeForModels.includes("*")) return true;
  const normalized = normalizeModelId(fullModelId);
  return shadow.activeForModels.some((candidate) => normalizeModelId(candidate) === normalized);
}

/** Normalize a model id for comparison: lowercase + strip whitespace. */
export function normalizeModelId(id) {
  return String(id ?? "").toLowerCase().replace(/\s+/g, "");
}