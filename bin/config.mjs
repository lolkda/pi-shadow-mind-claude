// Runtime configuration loader/validator. Mirrors pi-shadow-mind's config.ts.
// Legacy Pi fields are kept as compatible placeholders (parsed, not enforced).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { configPath } from "./paths.mjs";
import { normalizeExts } from "./trigger.mjs";

/** Mainstream language/script extensions for auto_review_exts. */
export const MAINSTREAM_EXTS = [
  "py", "ts", "tsx", "js", "jsx", "mjs", "cjs", "java", "kt", "kts", "go", "rs",
  "c", "h", "cc", "cpp", "hpp", "cs", "sh", "zsh", "bash", "ps1", "rb", "php",
  "swift", "scala", "sql", "dart", "lua", "pl", "r", "groovy", "ex", "exs",
  "erl", "clj", "cljs", "fs", "nim", "zig", "hs", "ml", "vue", "svelte",
  "html", "htm", "css", "scss", "proto", "prisma",
];

export const DEFAULT_CONFIG = {
  default_shadow_timeout_seconds: 300,
  headless_drain_timeout_seconds: 120, // legacy Pi field, not implemented
  result_batch_window_ms: 400, // legacy Pi field, not implemented
  default_shadow_model: null,
  default_thinking_level: "medium",
  max_report_chars: 4000,
  max_trajectory_chars: null, // null = no truncation, feed the full window
  use_safe_mode: true,
  report_delivery: "context", // "context" | "block" (experimental)
  shadow_persistence: "reuse", // "ephemeral" | "reuse"
  max_resume_turns: 20, // reuse mode: open a fresh session after this many turns
  auto_review_enabled: false, // off by default; on = auto-review when the turn touched listed extensions
  auto_review_exts: [...MAINSTREAM_EXTS],
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validate(raw) {
  const value = raw ?? {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("config must be a JSON object");

  const result = { ...DEFAULT_CONFIG };

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

  result.auto_review_enabled = value.auto_review_enabled === undefined
    ? DEFAULT_CONFIG.auto_review_enabled
    : Boolean(value.auto_review_enabled);
  result.auto_review_exts = (() => {
    const input = value.auto_review_exts;
    if (input === undefined || input === null) return [...DEFAULT_CONFIG.auto_review_exts];
    if (!Array.isArray(input) || input.some((item) => typeof item !== "string" || !/^\.?[a-z0-9]+$/i.test(item.trim()))) {
      throw new Error("auto_review_exts must be an array of extension strings like 'py' or '.py'");
    }
    return normalizeExts(input);
  })();

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