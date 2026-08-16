// Install manifest: sha1 of every tracked file in the repo and in the skills-dir
// copy at install time. admin.mjs status later diffs both against the manifest
// to surface repo-vs-installed drift.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const EXCLUDE = new Set([".git", "node_modules"]);
const BACKSLASH = String.fromCharCode(92);

/**
 * Recursively hash every file under dir, keyed by path relative to dir.
 * @param {string} dir
 * @param {string} [base]
 * @returns {Promise<Record<string, string>>}
 */
export async function buildManifest(dir, base = dir) {
  const result = {};
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDE.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await buildManifest(full, base));
    } else if (entry.isFile()) {
      const rel = relative(base, full).split(BACKSLASH).join("/");
      result[rel] = createHash("sha1").update(await readFile(full)).digest("hex");
    }
  }
  return result;
}

/**
 * Compare a recorded manifest against the live directory.
 * @param {Record<string, string>} expected path -> sha1 at install time
 * @param {string} dir current directory to scan
 * @returns {Promise<Array<{ path: string, state: "missing" | "changed" | "extra" }>>}
 */
export async function diffManifest(expected, dir) {
  const current = await buildManifest(dir);
  const items = [];
  for (const [path, hash] of Object.entries(expected)) {
    const actual = current[path];
    if (actual === undefined) items.push({ path, state: "missing" });
    else if (actual !== hash) items.push({ path, state: "changed" });
  }
  for (const path of Object.keys(current)) {
    if (!(path in expected)) items.push({ path, state: "extra" });
  }
  return items;
}
