// Per-session report queue: the background collector appends finished reports;
// the Stop hook claims the queue atomically (rename) and delivers them. Keeping
// reports in their own files (instead of state.json) preserves the rule that
// state.json has a single writer, so a collector's stale snapshot can never
// overwrite the hook's drain.

import { readFile, appendFile, mkdir, rename, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";

function reportsDir(agentDir) {
  return join(agentDir, "reports");
}

function queuePath(agentDir, sessionId) {
  return join(reportsDir(agentDir), `${sessionId}.jsonl`);
}

/** Append one finished report to the session's queue (collector side, single writer). */
export async function appendReport(agentDir, sessionId, report) {
  await mkdir(reportsDir(agentDir), { recursive: true });
  await appendFile(queuePath(agentDir, sessionId), `${JSON.stringify(report)}\n`, "utf8");
}

/**
 * Atomically claim and return all pending reports for a session, then remove
 * them. Claim = rename the queue to a unique name; only one drainer wins, so
 * the normal path never duplicates. A leftover claimed file from a crashed
 * drain is picked up on the next call, so reports are at-least-once delivered.
 *
 * @param {string} agentDir
 * @param {string} sessionId
 * @returns {Promise<Array<{ at: number, banner: string }>>}
 */
export async function claimReports(agentDir, sessionId) {
  const dir = reportsDir(agentDir);
  const prefix = `${sessionId}.jsonl`;
  await mkdir(dir, { recursive: true });
  const reports = [];
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return reports;
  }
  for (const name of entries) {
    const isQueue = name === prefix;
    const isClaimed = name.startsWith(`${prefix}.claimed`);
    if (!isQueue && !isClaimed) continue;
    const path = join(dir, name);
    const claimedPath = isQueue ? `${path}.claimed` : path;
    if (isQueue) {
      try {
        await rename(path, claimedPath);
      } catch {
        continue; // another drainer claimed it first
      }
    }
    try {
      const raw = await readFile(claimedPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const text = line.trim();
        if (!text) continue;
        try {
          reports.push(JSON.parse(text));
        } catch {
          // Skip a broken line; never fail the drain.
        }
      }
    } finally {
      await unlink(claimedPath).catch(() => {});
    }
  }
  return reports;
}