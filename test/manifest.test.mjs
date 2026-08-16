import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, diffManifest } from "../bin/manifest.mjs";

async function makeTree() {
  const dir = await mkdtemp(join(tmpdir(), "shadow-manifest-"));
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "a.txt"), "alpha\n", "utf8");
  await writeFile(join(dir, "sub", "b.txt"), "beta\n", "utf8");
  return dir;
}

test("buildManifest hashes every file with relative keys", async () => {
  const dir = await makeTree();
  try {
    const manifest = await buildManifest(dir);
    assert.equal(Object.keys(manifest).length, 2);
    assert.ok(manifest["a.txt"]);
    assert.ok(manifest["sub/b.txt"]);
    assert.match(manifest["a.txt"], /^[0-9a-f]{40}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildManifest is deterministic for unchanged files", async () => {
  const dir = await makeTree();
  try {
    const first = await buildManifest(dir);
    const second = await buildManifest(dir);
    assert.deepEqual(first, second);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diffManifest reports in-sync as empty", async () => {
  const dir = await makeTree();
  try {
    const manifest = await buildManifest(dir);
    assert.deepEqual(await diffManifest(manifest, dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diffManifest detects changed, missing and extra", async () => {
  const dir = await makeTree();
  try {
    const manifest = await buildManifest(dir);
    await writeFile(join(dir, "a.txt"), "changed\n", "utf8"); // changed
    await rm(join(dir, "sub", "b.txt")); // missing
    await writeFile(join(dir, "new.txt"), "new\n", "utf8"); // extra
    const diff = await diffManifest(manifest, dir);
    const byPath = Object.fromEntries(diff.map((d) => [d.path, d.state]));
    assert.equal(byPath["a.txt"], "changed");
    assert.equal(byPath["sub/b.txt"], "missing");
    assert.equal(byPath["new.txt"], "extra");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diffManifest throws when directory is gone", async () => {
  const dir = await makeTree();
  await rm(dir, { recursive: true, force: true });
  await assert.rejects(() => diffManifest({}, dir));
});
