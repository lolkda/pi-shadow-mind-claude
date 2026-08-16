// Disk-persisted runtime state, per-session keyed.
// Atomic writes via temp file + rename; stale run sweep for orphan recovery.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { statePath } from "./paths.mjs";
import { isPidAlive, killProcessTree } from "./util.mjs";

const DEFAULT_STATE = () => ({
  epoch: 0,
  paused: false,
  sessions: {}, // sessionId -> { epoch, activeRuns: [], delivered: [], lastHeartbeatAt }
  dailyBudgetSpentUsd: 0,
  budgetFrozenAt: null, // ISO date when daily budget freeze engaged
});

function emptySession() {
  return { epoch: 0, activeRuns: [], delivered: [], lastHeartbeatAt: null, claudeSessions: {} };
}

export class StateStore {
  constructor() {
    this.path = statePath;
    this.state = DEFAULT_STATE();
  }

  session(sessionId) {
    if (!this.state.sessions[sessionId]) this.state.sessions[sessionId] = emptySession();
    return this.state.sessions[sessionId];
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      this.state = {
        ...DEFAULT_STATE(),
        ...parsed,
        sessions: parsed.sessions ?? {},
      };
    } catch {
      this.state = DEFAULT_STATE();
    }
    return this.state;
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = join(dirname(this.path), `.state-${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(temp, this.path);
  }

  /** Kill shadow pids that are no longer alive or stale. Returns number of killed orphans. */
  async sweepStaleRuns(sessionIds, maxAgeMs = 3600_000) {
    let killed = 0;
    const now = Date.now();
    for (const [sessionId, sess] of Object.entries(this.state.sessions)) {
      if (sessionIds && !sessionIds.has(sessionId)) continue;
      const remaining = [];
      for (const run of sess.activeRuns ?? []) {
        const staleByAge = now - run.startedAt > maxAgeMs;
        const dead = !isPidAlive(run.pid);
        if (dead) {
          continue; // already gone; just drop the record
        }
        if (staleByAge) {
          const success = await killProcessTree(run.pid);
          killed += success ? 1 : 0;
          continue;
        }
        remaining.push(run);
      }
      sess.activeRuns = remaining;
    }
    if (killed > 0) await this.save();
    return killed;
  }
}

export { DEFAULT_STATE };