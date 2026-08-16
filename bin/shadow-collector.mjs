// Background shadow collector: receives one activation job on stdin from the
// Stop hook, runs each shadow detached from the main session, and files any
// report into state.pendingReports so a later Stop can drain it. The Stop hook
// never waits for this process; this one owns the shadow lifecycle to completion.
//
// Contract: reads a single JSON object from stdin, logs via shadow-debug.log,
// exits 0. Never touches the main session.

import { readFileSync } from "node:fs";
import { logDebug } from "./util.mjs";
import { StateStore } from "./state.mjs";
import { runShadow, formatReport, reportText } from "./runner.mjs";
import { appendReport } from "./reports.mjs";
import { agentDir } from "./paths.mjs";

const job = JSON.parse(readFileSync(0, "utf8"));
const log = (line) => logDebug(agentDir, `[collect:${job.sessionId.slice(0, 8)}] ${line}`);

async function main() {
  const state = new StateStore();
  await state.load();
  const sess = state.session(job.sessionId);
  sess.claudeSessions = sess.claudeSessions ?? {};
  let reportCount = 0;

  await Promise.allSettled(job.shadows.map(async (spec) => {
    const result = await runShadow({
      cwd: job.workdir,
      prompt: spec.prompt,
      toolWhitelist: spec.tools,
      model: spec.model,
      effort: spec.effort,
      useSafeMode: spec.useSafeMode,
      timeoutMs: spec.timeoutMs,
      persistSession: spec.persistSession,
      resumeSessionId: spec.resumeSessionId,
      onSpawn: (pid) => {
        sess.activeRuns = sess.activeRuns ?? [];
        sess.activeRuns.push({ pid, shadowId: spec.id, startedAt: Date.now() });
        void state.save();
      },
    });

    // The run finished (or was killed): remove it from the active set.
    sess.activeRuns = (sess.activeRuns ?? []).filter((run) => run.pid !== result.pid);

    if (result.reason !== "error" && result.reason !== "aborted") {
      // Approximate cost accounting: a shadow run is at least one API call.
      state.state.dailyBudgetSpentUsd = (state.state.dailyBudgetSpentUsd ?? 0) + 0.05;
    }

    // Persist the shadow's Claude session for the next activation (reuse mode).
    if (spec.persistSession && result.sessionId) {
      const prior = sess.claudeSessions[spec.id];
      sess.claudeSessions[spec.id] = { claudeSessionId: result.sessionId, turns: (prior?.turns ?? 0) + 1, lastAt: Date.now() };
    }

    const report = reportText(result.output);
    if (report) {
      // Reports go to the session's own queue file, never into state.json:
      // state.json stays single-writer so a stale snapshot cannot overwrite
      // the hook's drain (see reports.mjs).
      const banner = formatReport({ name: spec.name, id: spec.id }, report, job.maxReportChars);
      await appendReport(agentDir, job.sessionId, { at: Date.now(), banner });
      reportCount += 1;
      log(`report from ${spec.id} (${result.durationMs}ms, ${result.reason})`);
    } else {
      log(`silent from ${spec.id} (${result.durationMs}ms, ${result.reason}${result.exitCode !== undefined ? `, exit=${result.exitCode}` : ""})`);
    }
    await state.save();
  }));

  log(`batch done, reports=${reportCount}`);
  process.exit(0);
}

main().catch((error) => {
  log(`collector error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});