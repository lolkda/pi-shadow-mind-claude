// Stop hook: heartbeat → activate shadows → run them in parallel within the
// max_wait_ms budget → collect reports → inject via additionalContext.
// Contract: always exit 0; stdout is either an empty string or exactly one JSON object.

import { readStdinJson, logDebug } from "./util.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigStore } from "./config.mjs";
import { ShadowRegistry } from "./registry.mjs";
import { StateStore } from "./state.mjs";
import { decideHeartbeat, matchesModel, createRandom, normalizeModelId } from "./scheduler.mjs";
import { resolveMainModelId } from "./modelid.mjs";
import { serializeTrajectory } from "./trajectory.mjs";
import { runShadow, formatReport, SHADOW_PROTOCOL, mapToolNames } from "./runner.mjs";
import { agentDir } from "./paths.mjs";

/** Read a one-shot manual trigger written by "/shadow now [id]". */
async function readForceTrigger() {
  const path = join(agentDir, ".force-trigger.json");
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Consume the trigger file after a forced run. */
async function clearForceTrigger() {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(join(agentDir, ".force-trigger.json"));
  } catch {
    // Already gone; fine.
  }
}

const input = await readStdinJson();
if (process.env.CLAUDE_CODE_SHADOW_MIND === "1") process.exit(0);

const output = await main(input);
if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
process.exit(0);

async function main(input) {
  const sessionId = input?.session_id ?? input?.sessionId ?? "unknown";
  const cwd = input?.cwd ?? process.cwd();
  const log = (line) => logDebug(agentDir, `[stop:${sessionId.slice(0, 8)}] ${line}`);

  try {
    // Death-loop guard: if the last continuation came from our own injection, stop.
    if (input?.stop_hook_active === true) {
      log("stop_hook_active=true; skipping to avoid block loop");
      return null;
    }

    const configStore = new ConfigStore();
    await configStore.initialize();
    const { config, error } = await configStore.reload();
    if (error) log(`config error: ${error}`);

    const registry = new ShadowRegistry();
    const snapshot = await registry.load();
    if (snapshot.diagnostics.length) {
      log(`registry diagnostics: ${snapshot.diagnostics.map((d) => d.message).join("; ")}`);
    }

    const state = new StateStore();
    await state.load();
    await state.sweepStaleRuns(new Set([sessionId]), 3600_000); // reap orphans

    const sess = state.session(sessionId);
    if (state.state.paused) {
      log("paused; skip");
      return null;
    }
    if (config.daily_budget_usd !== null && state.state.dailyBudgetSpentUsd >= config.daily_budget_usd) {
      log("daily budget exhausted; skip");
      return null;
    }

    const mainModelId = normalizeModelId(await resolveMainModelId() ?? "");
    const activeIds = new Set((sess.activeRuns ?? []).map((run) => run.shadowId));

    // Manual trigger via "/shadow now [id]": a force file makes this heartbeat
    // deterministic (bypasses heartbeat_probability and activation_probability).
    const force = await readForceTrigger();
    const decision = force
      ? null
      : decideHeartbeat({
          heartbeatProbability: config.heartbeat_probability,
          availableSlots: Math.max(0, config.max_parallel_shadows - activeIds.size),
          shadows: snapshot.shadows,
          activeShadowIds: activeIds,
          mainModelId,
          random: createRandom(config.random_seed ?? undefined),
        });
    const activated = force
      ? snapshot.shadows.filter((shadow) => shadow.enabled
          && matchesModel(shadow, mainModelId)
          && !activeIds.has(shadow.id)
          && (force.id === undefined || force.id === "*" || force.id === shadow.id))
      : decision.activated.map(({ shadow }) => shadow);
    log(force
      ? `FORCED trigger activated=${activated.map(({ id }) => id).join(",") || "none"}`
      : `heartbeat roll=${decision.heartbeatRoll.toFixed(4)} activated=${activated.map(({ id }) => id).join(",") || "none"}`);

    if (!activated.length) {
      if (force) await clearForceTrigger();
      return null;
    }

    const trajectory = await serializeTrajectory(input?.transcript_path, {
      maxChars: config.max_trajectory_chars,
      lastAssistantMessage: input?.last_assistant_message,
    });
    log(`trajectory ${trajectory.length} chars`);

    // Run all activated shadows in parallel under one shared deadline.
    const deadline = Date.now() + config.max_wait_ms;
    sess.claudeSessions = sess.claudeSessions ?? {};

    const results = await Promise.allSettled(activated.map(async (shadow) => {
      const shadowTimeoutMs = (shadow.timeoutSeconds ?? config.default_shadow_timeout_seconds) * 1000;
      const timeoutMs = Math.min(shadowTimeoutMs, Math.max(1000, deadline - Date.now()));
      const whitelist = mapToolNames(shadow.tools).tools;

      // Persistence: reuse resumes the shadow's own Claude session; otherwise ephemeral.
      const mode = shadow.persistence ?? config.shadow_persistence;
      const prior = sess.claudeSessions[shadow.id];
      const resumeSessionId = mode === "reuse" && prior && prior.turns < config.max_resume_turns ? prior.claudeSessionId : undefined;

      const prompt = `${trajectory}\n\n${SHADOW_PROTOCOL}\n\n<shadow-mind id="${shadow.id}" name="${shadow.name}">\n${shadow.prompt}\n</shadow-mind>`;
      log(`spawn ${shadow.id} mode=${mode}${resumeSessionId ? ` resume=${resumeSessionId.slice(0, 8)}/${prior.turns}` : " fresh"} tools=${whitelist.join(",")} timeout=${timeoutMs}ms`);
      const result = await runShadow({
        cwd,
        prompt,
        toolWhitelist: whitelist,
        model: shadowModel(config, shadow),
        effort: config.default_thinking_level,
        useSafeMode: config.use_safe_mode,
        timeoutMs,
        persistSession: mode === "reuse",
        resumeSessionId,
        onSpawn: (pid) => {
          sess.activeRuns = sess.activeRuns ?? [];
          sess.activeRuns.push({ pid, shadowId: shadow.id, startedAt: Date.now() });
          void state.save();
        },
      });
      // The run finished (or was killed): remove it from the active set.
      sess.activeRuns = (sess.activeRuns ?? []).filter((run) => run.pid !== result.pid);

      // Persist the shadow's Claude session for the next activation (reuse mode).
      if (mode === "reuse" && result.sessionId) {
        sess.claudeSessions[shadow.id] = { claudeSessionId: result.sessionId, turns: (prior?.turns ?? 0) + 1, lastAt: Date.now() };
      }
      return { shadow, result, report: reportText(result.output) };
    }));

    const reports = [];
    for (const settled of results) {
      if (settled.status === "rejected") {
        log(`runner rejected: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`);
        continue;
      }
      const { shadow, result, report } = settled.value;
      if (result.reason !== "error" && result.reason !== "aborted") {
        // Approximate cost accounting: a shadow run is at least one API call.
        state.state.dailyBudgetSpentUsd = (state.state.dailyBudgetSpentUsd ?? 0) + 0.05;
      }
      if (report) {
        const banner = formatReport({ name: shadow.name, id: shadow.id }, report, config.max_report_chars);
        reports.push(banner);
        sess.delivered = sess.delivered ?? [];
        sess.delivered.push({ at: Date.now(), banner, text: report.slice(0, 200) });
        log(`report from ${shadow.id} (${result.durationMs}ms, ${result.reason})`);
      } else {
        log(`silent from ${shadow.id} (${result.durationMs}ms, ${result.reason}${result.exitCode !== undefined ? `, exit=${result.exitCode}` : ""})`);
      }
    }
    await state.save();
    if (force) await clearForceTrigger();

    if (!reports.length) return null;
    const injected = reports.join("\n\n");
    log(`injecting ${reports.length} report(s), ${injected.length} chars`);

    if (config.report_delivery === "block") {
      return { decision: "block", reason: injected.slice(0, 4000) };
    }
    return {
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: injected,
      },
    };
  } catch (inner) {
    log(`hook error: ${inner instanceof Error ? inner.message : String(inner)}`);
    return null;
  }
}

function reportText(output) {
  const text = (output ?? "").trim();
  if (!text || text.startsWith("NOT_RELEVANT")) return null;
  return text;
}

function shadowModel(config, shadow) {
  return shadow.runWithModel ?? config.default_shadow_model ?? undefined;
}