// Shadow definition registry: parses shadow-minds/*.md with mtime caching.
// Mirrors pi-shadow-mind's registry.ts.

import { mkdir, readFile, readdir, stat, writeFile, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { shadowDir } from "./paths.mjs";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.mjs";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const DEFAULT_READ_TOOLS = ["read", "grep", "find", "ls"];

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function parseShadowMarkdown(source, filePath) {
  const parsed = parseFrontmatter(source);
  if (!parsed) throw new Error("missing YAML frontmatter");
  const value = parsed.meta;
  const fallbackId = basename(filePath, extname(filePath));
  const id = value.id === undefined ? fallbackId : value.id;
  if (typeof id !== "string" || !id.trim()) throw new Error("id must be a non-empty string");
  if (!ID_PATTERN.test(id)) throw new Error("id must match [a-z0-9][a-z0-9_-]*");
  const prompt = parsed.body;
  if (!prompt) throw new Error("shadow prompt body is empty");
  return {
    id,
    name: (value.name ?? id).toString().trim() || id,
    enabled: value.enabled === undefined ? true : Boolean(value.enabled),
    debug: value.debug === undefined ? false : Boolean(value.debug),
    activationProbability: probability(value.activation_probability, 1),
    activeForModels: stringArray(value.active_for_models, ["*"]),
    runWithModel: optionalString(value.run_with_model),
    thinkingLevel: optionalString(value.thinking_level),
    timeoutSeconds: optionalPositive(value.timeout_seconds),
    persistence: enumValue(value.persistence, ["ephemeral", "reuse"], undefined),
    tools: stringArray(value.tools, []),
    prompt,
    filePath,
  };
}

function probability(value, fallback) {
  if (value === undefined) return fallback;
  if (!isFiniteNumber(value) || value < 0 || value > 1) throw new Error("activation_probability must be between 0 and 1");
  return value;
}

function optionalPositive(value) {
  if (value === undefined || value === null) return undefined;
  if (!isFiniteNumber(value) || value <= 0) throw new Error("timeout_seconds must be positive");
  return value;
}

function optionalString(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error("expects a non-empty string");
  return value.trim();
}

function enumValue(value, allowed, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`must be one of: ${allowed.join(", ")}`);
  return value;
}

function stringArray(value, fallback) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("expects an array of non-empty strings");
  }
  return [...new Set(value.map((item) => item.trim()))];
}

export class ShadowRegistry {
  constructor() {
    this.directory = shadowDir;
    this.cache = new Map(); // filePath -> { mtimeMs, shadow?, error? }
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true });
  }

  async load() {
    await this.initialize();
    const names = (await readdir(this.directory)).filter((name) => extname(name).toLowerCase() === ".md").sort();
    const shadows = [];
    const diagnostics = [];
    const seen = new Set();
    for (const name of names) {
      const filePath = join(this.directory, name);
      seen.add(filePath);
      const fileStat = await stat(filePath);
      const cached = this.cache.get(filePath);
      if (cached && cached.mtimeMs === fileStat.mtimeMs) {
        if (cached.shadow) shadows.push(cached.shadow);
        if (cached.error) diagnostics.push({ filePath, message: cached.error });
        continue;
      }
      try {
        const definition = parseShadowMarkdown(await readFile(filePath, "utf8"), filePath);
        this.cache.set(filePath, { mtimeMs: fileStat.mtimeMs, shadow: definition });
        shadows.push(definition);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.cache.set(filePath, { mtimeMs: fileStat.mtimeMs, error: message });
        diagnostics.push({ filePath, message });
      }
    }
    for (const filePath of [...this.cache.keys()]) {
      if (!seen.has(filePath)) this.cache.delete(filePath);
    }
    // Duplicate ids: first file wins.
    const unique = [];
    const ids = new Set();
    for (const shadow of shadows) {
      if (ids.has(shadow.id)) {
        diagnostics.push({ filePath: shadow.filePath, message: `duplicate shadow id: ${shadow.id}` });
      } else {
        ids.add(shadow.id);
        unique.push(shadow);
      }
    }
    return { shadows: unique, diagnostics };
  }

  serialize(shadow) {
    const meta = {
      id: shadow.id,
      name: shadow.name,
      enabled: shadow.enabled,
      debug: shadow.debug,
      activation_probability: shadow.activationProbability,
      active_for_models: shadow.activeForModels,
      ...(shadow.runWithModel !== undefined ? { run_with_model: shadow.runWithModel } : {}),
      ...(shadow.thinkingLevel !== undefined ? { thinking_level: shadow.thinkingLevel } : {}),
      ...(shadow.timeoutSeconds !== undefined ? { timeout_seconds: shadow.timeoutSeconds } : {}),
      ...(shadow.persistence !== undefined ? { persistence: shadow.persistence } : {}),
      tools: shadow.tools,
    };
    return serializeFrontmatter(meta, shadow.prompt);
  }
}

export { parseShadowMarkdown };