// UserPromptSubmit hook: new user input aborts running shadows for this session
// and invalidates pending reports (Pi's input-event epoch+1 / abortAll semantics).
// Contract: always exit 0, empty stdout (30s budget).

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readStdinJson, logDebug, killProcessTree } from "./util.mjs";
import { StateStore } from "./state.mjs";
import { agentDir } from "./paths.mjs";

const input = await readStdinJson();
if (process.env.CLAUDE_CODE_SHADOW_MIND === "1") process.exit(0);
await main(input);
process.exit(0);

async function main(input) {
  const sessionId = input?.session_id ?? input?.sessionId ?? "unknown";
  const log = (line) => logDebug(agentDir, `[input:${sessionId.slice(0, 8)}] ${line}`);
  try {
    const state = new StateStore();
    await state.load();
    const sess = state.session(sessionId);
    sess.epoch += 1;
    sess.pendingReports = [];
    const runs = sess.activeRuns ?? [];
    sess.activeRuns = [];
    for (const run of runs) {
      log(`abort ${run.shadowId} pid=${run.pid}`);
      try {
        await killProcessTree(run.pid);
      } catch {
        // Process already gone; ignore.
      }
    }
    // Aborting the run invalidates the pending one-shot review: consume any
    // stale force trigger so the next Stop cannot silently re-activate.
    await rm(join(agentDir, ".force-trigger.json"), { force: true });
    await state.save();
  } catch (inner) {
    log(`hook error: ${inner instanceof Error ? inner.message : String(inner)}`);
  }
}