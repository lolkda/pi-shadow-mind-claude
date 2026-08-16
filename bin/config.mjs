// Runtime configuration loader/validator. Mirrors pi-shadow-mind's config.ts.
// Legacy Pi fields are kept as compatible placeholders (parsed, not enforced).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { configPath } from "./paths.mjs";

export const DEFAULT_CONFIG = {
  heartbeat_probability: 1 / 3,
  max_parallel_shadows: 2,
  default_shadow_timeout_seconds: 300,
  headless_drain_timeout_seconds: 120, // legacy Pi field, not implemented
  result_batch_window_ms: 400, // legacy Pi field, not implemented
  default_shadow_model: null,
  default_thinking_level: "medium",
  random_seed: null,
  max_report_chars: 4000,
  max_trajectory_chars: null, // null = no truncation, feed the full window
  use_safe_mode: true,
  daily_budget_usd: null,
  report_delivery: "context", // "context" | "block" (experimental)
  shadow_persistence: "reuse", // "ephemeral" | "reuse"
  max_resume_turns: 20, // reuse mode: open a fresh session after this many turns
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validate(raw) {
  const value = raw ?? {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("config must be a JSON object");

  const result = { ...DEFAULT_CONFIG };

  const range = (name, min, max, fallback) => {
    const input = value[name];
    if (input === undefined) return fallback;
    if (!isFiniteNumber(input) || input < min || input > max) throw new Error(`${name} must be between ${min} and ${max}`);
    return input;
  };
  const positive = (name, fallback) => {
    const input = value[name];
    if (input === undefined) return fallback;
    if (!isFiniteNumber(input) || input <= 0) throw new Error(`${name} must be positive`);
    return input;
  };
  const positiveInt = (name, fallback) => {
    const parsed = positive(name, fallback);
    if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
    return parsed;
  };
  const nonNegativeInt = (name, fallback) => {
    const input = value[name];
    if (input === undefined) return fallback;
    if (!isFiniteNumber(input) || !Number.isInteger(input) || input < 0) throw new Error(`${name} must be a non-negative integer`);
    return input;
  };

  result.heartbeat_probability = range("heartbeat_probability", 0, 1, DEFAULT_CONFIG.heartbeat_probability);
  result.max_parallel_shadows = positiveInt("max_parallel_shadows", DEFAULT_CONFIG.max_parallel_shadows);
  result.default_shadow_timeout_seconds = positive("default_shadow_timeout_seconds", DEFAULT_CONFIG.default_shadow_timeout_seconds);
  result.headless_drain_timeout_seconds = positive("headless_drain_timeout_seconds", DEFAULT_CONFIG.headless_drain_timeout_seconds);
  result.result_batch_window_ms = nonNegativeInt("result_batch_window_ms", DEFAULT_CONFIG.result_batch_window_ms);
  result.max_report_chars = nonNegativeInt("max_report_chars", DEFAULT_CONFIG.max_report_chars);
  result.max_trajectory_chars = (() => {
    const input = value.max_trajectory_chars;
    if (input === undefined || input === null) return null; // null = feed the full window, no truncation
    if (!isFiniteNumber(input) || !Number.isInteger(input) || input < 0) {
      throw new Error("max_trajectory_chars must be a non-negative integer or null");
    }
    return input;
  })();
  result.daily_budget_usd = (() => {
    const input = value.daily_budget_usd;
    if (input === undefined || input === null) return null;
    if (!isFiniteNumber(input) || input < 0) throw new Error("daily_budget_usd must be non-negative or null");
    return input;
  })();
  result.random_seed = (() => {
    const input = value.random_seed;
    if (input === undefined || input === null) return null;
    if (!isFiniteNumber(input) || !Number.isInteger(input) || input < 0 || input > 0xffff_ffff) {
      throw new Error("random_seed must be an integer between 0 and 4294967295");
    }
    return input;
  })();
  for (const name of ["default_shadow_model"]) {
    const input = value[name];
    if (input === undefined || input === null) continue;
    if (typeof input !== "string" || !input.trim()) throw new Error(`${name} must be a non-empty string or null`);
    result[name] = input.trim();
  }
  const thinking = value.default_thinking_level ?? DEFAULT_CONFIG.default_thinking_level;
  if (!THINKING_LEVELS.has(thinking)) throw new Error("default_thinking_level is invalid");
  result.default_thinking_level = thinking;
  const safeMode = value.use_safe_mode;
  result.use_safe_mode = safeMode === undefined ? DEFAULT_CONFIG.use_safe_mode : Boolean(safeMode);
  const delivery = value.report_delivery ?? DEFAULT_CONFIG.report_delivery;
  if (delivery !== "context" && delivery !== "block") throw new Error("report_delivery must be \"context\" or \"block\"");
  result.report_delivery = delivery;

  const persistence = value.shadow_persistence ?? DEFAULT_CONFIG.shadow_persistence;
  if (persistence !== "ephemeral" && persistence !== "reuse") throw new Error("shadow_persistence must be \"ephemeral\" or \"reuse\"");
  result.shadow_persistence = persistence;

  result.max_resume_turns = positiveInt("max_resume_turns", DEFAULT_CONFIG.max_resume_turns);

  return result;
}

export class ConfigStore {
  constructor() {
    this.configPath = configPath;
    this.lastGood = { ...DEFAULT_CONFIG };
    this.lastError = undefined;
  }

  async initialize() {
    await mkdir(dirname(this.configPath), { recursive: true });
    try {
      await readFile(this.configPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await writeFile(this.configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
    }
    await this.reload();
  }

  async reload() {
    try {
      const raw = await readFile(this.configPath, "utf8");
      this.lastGood = validate(JSON.parse(raw));
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    return { config: this.lastGood, error: this.lastError };
  }

  get current() {
    return this.lastGood;
  }

  get error() {
    return this.lastError;
  }

  async write(config) {
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    this.lastGood = config;
    this.lastError = undefined;
  }
}

export { validate as validateConfig };