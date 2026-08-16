import { test } from "node:test";
import assert from "node:assert/strict";
import { StateStore } from "../bin/state.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeStore() {
  return mkdtemp(join(tmpdir(), "shadow-state-"));
}

test("session() creates and reuses session key", () => {
  const store = new StateStore();
  store.state.sessions = {};
  const first = store.session("abc");
  assert.equal(first.epoch, 0);
  assert.deepEqual(first.activeRuns, []);
  assert.equal(store.state.sessions["abc"], first);
  assert.equal(store.session("abc"), first);
  const second = store.session("def");
  assert.notEqual(second, first);
});

test("load/save round-trip persists sessions", async () => {
  const dir = await makeStore();
  const path = join(dir, "state.json");
  const store = new StateStore();
  store.path = path;
  store.session("s1");
  store.state.sessions["s1"].epoch = 5;
  store.state.sessions["s1"].activeRuns = [{ pid: 123, shadowId: "x", startedAt: Date.now() }];
  store.state.sessions["s1"].delivered = [{ at: 1, banner: "[x / x]", text: "hi" }];
  await store.save();

  const other = new StateStore();
  other.path = path;
  await other.load();
  assert.equal(other.state.sessions["s1"].epoch, 5);
  assert.equal(other.state.sessions["s1"].activeRuns.length, 1);
  assert.equal(other.state.sessions["s1"].delivered[0].text, "hi");
  await rm(dir, { recursive: true, force: true });
});

test("load tolerates missing/corrupt file", async () => {
  const dir = await makeStore();
  const store = new StateStore();
  store.path = join(dir, "nope.json");
  await store.load();
  assert.equal(store.state.epoch, 0);
  assert.equal(store.state.paused, false);
  await rm(dir, { recursive: true, force: true });
});

test("save survives a locked target file (EPERM fallback)", async () => {
  const dir = await makeStore();
  // Inject a rename that always throws EPERM to exercise the fallback path.
  let threw = false;
  const store = new StateStore({
    rename: async () => {
      threw = true;
      const e = new Error("EPERM: operation not permitted, rename");
      e.code = "EPERM";
      throw e;
    },
  });
  store.path = join(dir, "state.json");
  store.session("s1").epoch = 8;
  await store.save();
  assert.ok(threw, "rename fallback path was exercised");
  const { readFile } = await import("node:fs/promises");
  const onDisk = JSON.parse(await readFile(store.path, "utf8"));
  assert.equal(onDisk.sessions["s1"].epoch, 8);
  await rm(dir, { recursive: true, force: true });
});

test("sweepStaleRuns drops dead process records and keeps live fresh ones", async () => {
  const dir = await makeStore();
  const store = new StateStore();
  store.path = join(dir, "state.json");
  const livePid = process.pid; // definitely alive
  store.session("s1").activeRuns = [
    { pid: 9_999_999, shadowId: "dead", startedAt: Date.now() }, // pid too big -> kill(pid,0) throws => dead
    { pid: livePid, shadowId: "alive", startedAt: Date.now() },
  ];
  const killed = await store.sweepStaleRuns(new Set(["s1"]), 3600_000);
  assert.equal(killed, 0); // nothing age-stale killed; dead record just dropped
  const active = store.session("s1").activeRuns;
  assert.equal(active.length, 1);
  assert.equal(active[0].shadowId, "alive");
  await rm(dir, { recursive: true, force: true });
});