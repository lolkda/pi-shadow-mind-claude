// SessionEnd hook: orphan sweep only (1.5s budget). Kills stale shadow pids for
// the session that is ending; never starts new shadows.

import { readStdinJson, logDebug, killProcessTree } from "./util.mjs";
import { StateStore } from "./state.mjs";
import { agentDir } from "./paths.mjs";

const input = await readStdinJson();
if (process.env.CLAUDE_CODE_SHADOW_MIND === "1") process.exit(0);
await main(input);
process.exit(0);

async function main(input) {
  const sessionId = input?.session_id ?? input?.sessionId ?? "unknown";
  const log = (line) => logDebug(agentDir, `[end:${sessionId.slice(0, 8)}] ${line}`);
  try {
    const state = new StateStore();
    await state.load();
    const sess = state.session(sessionId);
    const runs = sess.activeRuns ?? [];
    sess.activeRuns = [];
    for (const run of runs) {
      log(`orphan sweep ${run.shadowId} pid=${run.pid}`);
      try {
        await killProcessTree(run.pid);
      } catch {
        // Ignore: process already gone.
      }
    }
    await state.save();
  } catch (inner) {
    log(`hook error: ${inner instanceof Error ? inner.message : String(inner)}`);
  }
}