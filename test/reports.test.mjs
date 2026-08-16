import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendReport, claimReports } from "../bin/reports.mjs";

async function withAgentDir(run) {
  const agentDir = await mkdtemp(join(tmpdir(), "shadow-reports-test-"));
  try {
    await run(agentDir);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

test("append then claim delivers every report exactly once", async () => {
  await withAgentDir(async (agentDir) => {
    await appendReport(agentDir, "sess-1", { at: 1, banner: "[A / a]\nhello" });
    await appendReport(agentDir, "sess-1", { at: 2, banner: "[B / b]\nworld" });
    // a different session's queue stays untouched
    await appendReport(agentDir, "sess-2", { at: 3, banner: "[C / c]\nother" });

    const first = await claimReports(agentDir, "sess-1");
    assert.equal(first.length, 2);
    assert.deepEqual(first.map((r) => r.banner), ["[A / a]\nhello", "[B / b]\nworld"]);

    // queue is consumed: nothing left to claim
    const second = await claimReports(agentDir, "sess-1");
    assert.equal(second.length, 0);

    // other session unaffected
    const other = await claimReports(agentDir, "sess-2");
    assert.equal(other.length, 1);
  });
});

test("claim recovers reports left by a crashed drain (claimed leftovers)", async () => {
  await withAgentDir(async (agentDir) => {
    await appendReport(agentDir, "sess-1", { at: 1, banner: "[A / a]\nleftover" });
    // simulate a drain that claimed the file but died before delivery
    const want = join(agentDir, "reports", "sess-1.jsonl.claimed");
    const { rename } = await import("node:fs/promises");
    await rename(join(agentDir, "reports", "sess-1.jsonl"), want);

    const recovered = await claimReports(agentDir, "sess-1");
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].banner, "[A / a]\nleftover");
    // and no duplicates afterwards
    assert.equal((await claimReports(agentDir, "sess-1")).length, 0);
  });
});

test("broken lines are skipped, never fatal", async () => {
  await withAgentDir(async (agentDir) => {
    await appendReport(agentDir, "sess-1", { at: 1, banner: "[A / a]\nok" });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(agentDir, "reports", "sess-1.jsonl"), "{corrupt\n", "utf8");

    const reports = await claimReports(agentDir, "sess-1");
    assert.equal(reports.length, 1);
    assert.equal(reports[0].banner, "[A / a]\nok");
  });
});