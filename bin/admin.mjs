// Admin CLI: status | pause | resume | hide | list | create | update | delete | config
// Usage: node bin/admin.mjs <command> [args...]
// All writes to shadow definition files are plain file operations; user confirmation
// is the responsibility of the invoking agent/user.

import { writeFile, unlink, readFile, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { configPath, statePath, shadowDir, agentDir } from "./paths.mjs";
import { ConfigStore, validateConfig } from "./config.mjs";
import { ShadowRegistry, parseShadowMarkdown } from "./registry.mjs";

const registry = new ShadowRegistry();
const configStore = new ConfigStore();

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return { epoch: 0, paused: false, sessions: {}, dailyBudgetSpentUsd: 0 };
  }
}

async function writeState(state) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function cmdStatus() {
  await configStore.initialize();
  await registry.initialize();
  const { config, error } = await configStore.reload();
  const snapshot = await registry.load();
  const state = await readState();
  const configLines = [
    "Shadow Mind status",
    `config: ${error ?? "ok"}`,
    `heartbeat ${config.heartbeat_probability} · max parallel ${config.max_parallel_shadows} · wait ${config.max_wait_ms}ms · timeout ${config.default_shadow_timeout_seconds}s · effort ${config.default_thinking_level}`,
    `safe-mode ${config.use_safe_mode} · report ${config.report_delivery} · daily budget ${config.daily_budget_usd ?? "unset"} (spent ${state.dailyBudgetSpentUsd.toFixed(3)})`,
    `definitions: ${snapshot.shadows.length} valid · ${snapshot.diagnostics.length} invalid`,
    ...snapshot.diagnostics.map((d) => `  ! ${d.filePath}: ${d.message}`),
  ];
  const sessionLines = Object.entries(state.sessions).map(([sessionId, sess]) => {
    const active = sess.activeRuns?.length ?? 0;
    const sessions = sess.claudeSessions ?? {};
    const reuse = Object.entries(sessions).map(([shadowId, s]) => `${shadowId}(${s.turns}t)`).join(", ");
    return `session ${sessionId.slice(0, 8)} · epoch ${sess.epoch ?? state.epoch} · active ${active} · delivered ${sess.delivered?.length ?? 0}${reuse ? ` · reuse: ${reuse}` : ""}`;
  });
  const header = state.paused ? "paused" : "active";
  return [`🐙 Shadow Mind · ${header}`, ...configLines, ...(sessionLines.length ? ["", "sessions:", ...sessionLines] : []), "", "Commands: /shadow pause | resume | status | hide", "", "Shadows:",
    ...(snapshot.shadows.length ? snapshot.shadows.map((s) => `  ${s.enabled ? "enabled" : "disabled"} ${s.id} (${s.name}) p=${s.activationProbability} models=${s.activeForModels.join(",")} tools=${s.tools.join(",") || "default"} file=${s.filePath}`) : ["  (none)"]),
  ].join("\n");
}

async function cmdConfig(action) {
  await configStore.initialize();
  if (action === "get") {
    const { config, error } = await configStore.reload();
    return `${error ? `config error: ${error}\n` : ""}${JSON.stringify(config, null, 2)}`;
  }
  if (action !== "set") throw new Error("usage: config get | set <key> <value>");
  const [key, rawValue] = process.argv.slice(4);
  if (!key || rawValue === undefined) throw new Error("usage: config set <key> <value>");
  const current = configStore.current;
  let value;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue;
  }
  const next = { ...current, [key]: value };
  // Validate via the store's own validator before persisting.
  const validated = validateConfig(next);
  await configStore.write(validated);
  return `config updated: ${key} = ${JSON.stringify(value)}`;
}

async function cmdShadow(action, id, extra) {
  await registry.initialize();
  const snapshot = await registry.load();
  if (action === "list") {
    return snapshot.diagnostics.length
      ? `${snapshot.diagnostics.map((d) => `! ${d.filePath}: ${d.message}`).join("\n")}\n`
      : snapshot.shadows.length
        ? snapshot.shadows.map((s) => `${s.enabled ? "enabled" : "disabled"} ${s.id} (${s.name}) p=${s.activationProbability} models=${s.activeForModels.join(",")} tools=${s.tools.join(",") || "default"} file=${s.filePath}`).join("\n")
        : "(no shadow definitions)";
  }
  if (action === "create") {
    if (!id) throw new Error("usage: create <id> [name] [prompt-file]");
    const filePath = join(shadowDir, `${id}.md`);
    const name = extra ?? id;
    const prompt = "Describe this Shadow Mind's responsibility.";
    const source = registry.serialize({ id, name, enabled: true, debug: false, activationProbability: 1, activeForModels: ["*"], runWithModel: undefined, thinkingLevel: undefined, timeoutSeconds: undefined, tools: [], prompt });
    if (snapshot.shadows.some((s) => s.id === id)) throw new Error(`shadow already exists: ${id}`);
    const parsed = parseShadowMarkdown(source, filePath);
    await writeFile(filePath, source, { encoding: "utf8", flag: "wx" });
    return `Created ${id} (${parsed.name}) at ${filePath}\nEdit the body to describe its responsibility.`;
  }
  if (action === "delete") {
    if (!id) throw new Error("usage: delete <id>");
    const target = snapshot.shadows.find((s) => s.id === id);
    if (!target) throw new Error(`shadow not found: ${id}`);
    await unlink(target.filePath);
    return `Deleted ${id}; debug logs were retained.`;
  }
  throw new Error(`unknown shadow action: ${action}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  let output;
  switch (command) {
    case "status":
      output = await cmdStatus();
      break;
    case "list":
      output = await cmdShadow("list");
      break;
    case "create":
      output = await cmdShadow("create", rest[0], rest[1]);
      break;
    case "delete":
      output = await cmdShadow("delete", rest[0]);
      break;
    case "config":
      output = await cmdConfig(rest[0]);
      break;
    case "pause": {
      const state = await readState();
      state.paused = true;
      await writeState(state);
      output = "Shadow Mind paused.";
      break;
    }
    case "resume": {
      const state = await readState();
      state.paused = false;
      await writeState(state);
      output = "Shadow Mind resumed.";
      break;
    }
    case "now": {
      // One-shot manual trigger: the next Stop hook fires shadows deterministically.
      const targetId = rest[0] ?? "*";
      const snapshot = await registry.load();
      if (targetId !== "*" && !snapshot.shadows.some((s) => s.id === targetId)) {
        throw new Error(`shadow not found: ${targetId}`);
      }
      await rm(join(agentDir, ".force-trigger.json"), { force: true });
      await writeFile(join(agentDir, ".force-trigger.json"), `${JSON.stringify({ id: targetId, at: Date.now() }, null, 2)}\n`, "utf8");
      output = `Force trigger armed: next turn will review ${targetId === "*" ? "all enabled shadows" : targetId}. Ask the main agent anything to end its current turn, then watch for reports.`;
      break;
    }
    default:
      throw new Error("usage: status | pause | resume | now [id] | list | create | delete | config get|set");
  }
  process.stdout.write(`${output}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`[shadow-mind] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}