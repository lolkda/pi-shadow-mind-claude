// Stop hook: explicit activation only — a "/shadow now [id]" force file opts a
// batch of shadows into a detached background collector; later Stops drain
// finished reports via additionalContext. The hook itself never waits on
// shadows and never activates them on its own.
// Contract: always exit 0; stdout is either an empty string or exactly one JSON object.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readStdinJson, logDebug } from "./util.mjs";
import { ConfigStore } from "./config.mjs";
import { ShadowRegistry } from "./registry.mjs";
import { StateStore } from "./state.mjs";
import { matchesModel, normalizeModelId, forceTriggerValid } from "./scheduler.mjs";
import { resolveMainModelId } from "./modelid.mjs";
import { serializeTrajectory } from "./trajectory.mjs";
import { SHADOW_PROTOCOL, mapToolNames } from "./runner.mjs";
import { claimReports } from "./reports.mjs";
import { agentDir } from "./paths.mjs";

/** Detach the activated batch to the background collector; never wait here. */
function spawnCollector(job) {
  const script = join(dirname(fileURLToPath(import.meta.url)), "shadow-collector.mjs");
  const child = spawn(process.execPath, [script], {
    windowsHide: true,
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.write(`${JSON.stringify(job)}\n`);
  child.stdin.end();
  return child;
}

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
  } catch (error) {
    logDebug(agentDir, `[stop] clearForceTrigger failed: ${error instanceof Error ? error.message : String(error)}`);
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

    // 1) Drain finished background reports first: a completed batch's findings
    // are delivered before any new activation is considered this turn.
    const drained = await drainReports(agentDir, sessionId, state, sess, config, log);
    if (drained) {
      return drained;
    }

    if (state.state.paused) {
      log("paused; skip");
      return null;
    }

    // 2) One batch at a time: while shadows still run for this session, defer.
    // An explicit /shadow now force file is left untouched so it fires once the
    // current batch drains.
    if ((sess.activeRuns ?? []).length > 0) {
      log(`batch active (${sess.activeRuns.length} run(s)); defer${await readForceTrigger() ? " force" : ""}`);
      return null;
    }

    const mainModelId = normalizeModelId(await resolveMainModelId() ?? "");
    const activeIds = new Set((sess.activeRuns ?? []).map((run) => run.shadowId));

    // Activation is explicit-only: "/shadow now [id]" writes a one-shot force
    // file; there is no automatic draw. Consume the trigger immediately. If
    // this hook gets interrupted (e.g. a new user prompt aborts the run), a
    // stale force file must not silently activate shadows on a later Stop.
    const force = await readForceTrigger();
    if (force) {
      if (!forceTriggerValid(force)) {
        log("force trigger expired; discarding");
        await clearForceTrigger();
        return null;
      }
      await clearForceTrigger();
    }
    const activated = !force
      ? []
      : snapshot.shadows.filter((shadow) => shadow.enabled
          && matchesModel(shadow, mainModelId)
          && !activeIds.has(shadow.id)
          && (force.id === undefined || force.id === "*" || force.id === shadow.id));
    log(force
      ? `FORCED trigger activated=${activated.map(({ id }) => id).join(",") || "none"}`
      : "no manual trigger; skip");

    if (!activated.length) {
      return null;
    }

    const trajectory = await serializeTrajectory(input?.transcript_path, {
      // null config = feed the full window; Infinity disables the char cap.
      maxChars: config.max_trajectory_chars ?? Infinity,
      lastAssistantMessage: input?.last_assistant_message,
    });
    log(`trajectory ${trajectory.length} chars`);

    // Build the per-shadow specs. Each runs up to its own timeout_seconds; the
    // Stop-completion budget (hooks.json: 600s) is the hard ceiling, so cap the
    // per-shadow budget just under it as a guard.
    const HOOK_BUDGET_MS = 590_000;
    const specs = activated.map((shadow) => {
      const shadowTimeoutMs = (shadow.timeoutSeconds ?? config.default_shadow_timeout_seconds) * 1000;
      const timeoutMs = Math.min(shadowTimeoutMs, HOOK_BUDGET_MS);
      const whitelist = mapToolNames(shadow.tools).tools;

      // Persistence: reuse resumes the shadow's own Claude session; otherwise ephemeral.
      const mode = shadow.persistence ?? config.shadow_persistence;
      const prior = sess.claudeSessions?.[shadow.id];
      const resumeSessionId = mode === "reuse" && prior && prior.turns < config.max_resume_turns ? prior.claudeSessionId : undefined;

      // Tell the shadow its hard budget up front: it has no clock, but the
      // stated limit steers it toward targeted checks and an early report
      // instead of exhaustive scans that run into the kill.
      const prompt = `${trajectory}\n\n${SHADOW_PROTOCOL}\n\n<shadow-mind id="${shadow.id}" name="${shadow.name}">\n${shadow.prompt}\n</shadow-mind>\n\nTime budget: you must finish your review and report within ${Math.round(timeoutMs / 1000)} seconds. Plan for it - prefer targeted verification over exhaustive scans and start drafting the report early.`;
      log(`spawn ${shadow.id} mode=${mode}${resumeSessionId ? ` resume=${resumeSessionId.slice(0, 8)}/${prior.turns}` : " fresh"} tools=${whitelist.join(",")} timeout=${timeoutMs}ms`);
      return {
        id: shadow.id,
        name: shadow.name,
        prompt,
        tools: whitelist,
        model: shadowModel(config, shadow) ?? null,
        effort: config.default_thinking_level,
        useSafeMode: config.use_safe_mode,
        timeoutMs,
        persistSession: mode === "reuse",
        resumeSessionId,
      };
    });

    // Hand the whole batch to the detached collector and return immediately:
    // the main session never waits on shadows. Reports surface via a later
    // Stop's drain path.
    spawnCollector({
      sessionId,
      workdir: cwd,
      maxReportChars: config.max_report_chars,
      shadows: specs,
    });
    log(`collector spawned for ${specs.map((s) => s.id).join(",")}`);
    return null;
  } catch (inner) {
    log(`hook error: ${inner instanceof Error ? inner.message : String(inner)}`);
    return null;
  }
}

function shadowModel(config, shadow) {
  return shadow.runWithModel ?? config.default_shadow_model ?? undefined;
}

/**
 * Deliver finished background reports. Report delivery runs entirely on the
 * per-session queue file (collector appends, this drains by atomic rename), so
 * it cannot race with the collector's state writes.
 */
async function drainReports(agentDirPath, sessionId, state, sess, config, log) {
  const pending = await claimReports(agentDirPath, sessionId);
  if (!pending.length) return null;
  log(`draining ${pending.length} pending report(s)`);
  // Delivered history is best-effort only; a concurrent collector state.save()
  // may overwrite it, which never affects delivery itself.
  sess.delivered = sess.delivered ?? [];
  sess.delivered.push(...pending);
  void state.save();
  const injected = pending.map((report) => report.banner).join("\n\n");
  if (config.report_delivery === "block") {
    return { decision: "block", reason: injected.slice(0, 4000) };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: injected,
    },
  };
}