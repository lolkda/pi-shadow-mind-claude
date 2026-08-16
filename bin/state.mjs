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
  constructor(options = {}) {
    this.path = statePath;
    this.state = DEFAULT_STATE();
    // Test seam: allow injecting a rename implementation (defaults to fs).
    this._rename = options.rename ?? rename;
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
    // Windows EPERM: rename fails when another process (e.g. a concurrent hook
    // or another session) has state.json open. Retry, then fall back to a
    // direct write so state is never lost.
    try {
      await this._rename(temp, this.path);
    } catch {
      await waitMs(30);
      try {
        await this._rename(temp, this.path);
      } catch {
        try {
          const content = await readFile(temp, "utf8");
          await writeFile(this.path, content, "utf8");
        } finally {
          try { await rename(temp, temp + ".bak"); } catch { /* ignore */ }
        }
      }
    }
  }

  /** Kill shadow pids that are no longer alive or stale. Returns number of killed orphans. */
  async sweepStaleRuns(sessionIds, maxAgeMs = 3600_000) {
    let killed = 0;
    let changed = false;
    const now = Date.now();
    for (const [sessionId, sess] of Object.entries(this.state.sessions)) {
      if (sessionIds && !sessionIds.has(sessionId)) continue;
      const remaining = [];
      for (const run of sess.activeRuns ?? []) {
        const staleByAge = now - run.startedAt > maxAgeMs;
        const dead = !isPidAlive(run.pid);
        if (dead) {
          // A crashed collector can leave dead pid records behind; dropping
          // them must persist or the one-batch-at-a-time gate never re-opens.
          changed = true;
          continue;
        }
        if (staleByAge) {
          const success = await killProcessTree(run.pid);
          killed += success ? 1 : 0;
          changed = true;
          continue;
        }
        remaining.push(run);
      }
      sess.activeRuns = remaining;
    }
    if (changed) await this.save();
    return killed;
  }
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { DEFAULT_STATE };