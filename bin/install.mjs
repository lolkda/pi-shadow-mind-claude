// One-command installer: makes a cloned plugin usable immediately.
//   node bin/install.mjs [<pluginDir>]
//
// Steps (all idempotent):
//   1. Resolve pluginDir (script location) and nodePath (current node).
//   2. Generate hooks.json from hooks/hooks.template.json with absolute paths.
//   3. Ensure ~/.claude/shadow-minds exists with default config.json.
//   4. Copy example shadow definitions (shadow-minds/*.md) if none exist yet.
//   5. Write ~/.claude/shadow-mind.json marker for the /shadow command.
//   6. Optionally copy the plugin under ~/.claude/skills/<pluginName>/ for
//      auto-load as <pluginName>@skills-dir (mode: "install" | "link" | "skip").

import { readFile, writeFile, mkdir, copyFile, cp, rm, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const pluginDir = normalize(process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url))));
const nodePath = normalize(process.argv[3] ?? process.execPath);
const home = homedir();
const claudeDir = join(home, ".claude");
const agentDir = join(claudeDir, "shadow-minds");
const markerPath = join(claudeDir, "shadow-mind.json");
const skillsDir = join(claudeDir, "skills");

function normalize(p) {
  return p.replace(/\\/g, "/");
}

async function ensureAgentDir() {
  await mkdir(agentDir, { recursive: true });
  const configPath = join(agentDir, "config.json");
  try {
    await readFile(configPath);
  } catch {
    await copyFile(join(pluginDir, "shadow-minds", "config.json"), configPath);
  }
}

async function generateHooks() {
  const template = await readFile(join(pluginDir, "hooks", "hooks.template.json"), "utf8");
  const rendered = template.replaceAll("{{NODE_PATH}}", nodePath).replaceAll("{{PLUGIN_DIR}}", pluginDir);
  await writeFile(join(pluginDir, "hooks", "hooks.json"), rendered, "utf8");
}

async function seedShadows() {
  // Copies bundled examples into the live shadow registry dir, renamed from
  //  <id>.example.md -> <id>.md, and never overwrites user definitions.
  await mkdir(agentDir, { recursive: true });
  const srcDir = join(pluginDir, "shadow-minds");
  const examples = (await readdir(srcDir)).filter((name) => name.endsWith(".example.md"));
  const existing = (await readdir(agentDir)).filter((name) => name.endsWith(".md"));
  for (const name of examples) {
    const targetName = name.replace(/\.example\.md$/, ".md");
    if (existing.includes(targetName)) continue; // never clobber user definitions
    await copyFile(join(srcDir, name), join(agentDir, targetName));
  }
}

async function writeMarker() {
  await writeFile(markerPath, `${JSON.stringify({ pluginDir, nodePath, installedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

async function installSkillsCopy() {
  // Auto-load as <pluginName>@skills-dir so hooks load in every new session.
  const name = "pi-shadow-mind";
  const target = join(skillsDir, name);
  await mkdir(skillsDir, { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(pluginDir, target, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).includes(".git"),
  });
  // The copy's own hooks.json now points at the ORIGINAL pluginDir paths, but the
  // copy must self-reference: regenerate hooks.json inside the copy.
  const copyHooks = join(target, "hooks", "hooks.json");
  const template = await readFile(join(target, "hooks", "hooks.template.json"), "utf8");
  await writeFile(copyHooks, template.replaceAll("{{NODE_PATH}}", nodePath).replaceAll("{{PLUGIN_DIR}}", normalize(target)), "utf8");
  await writeFile(join(target, "shadow-minds", ".git-branch-marker"), "skills-dir copy\n", "utf8");
  return target;
}

// --- main ---
await ensureAgentDir();
await generateHooks();
await seedShadows();
await writeMarker();
const copyTarget = await installSkillsCopy();

process.stdout.write([
  "pi-shadow-mind installed.",
  `  plugin:  ${pluginDir}`,
  `  hooks:   ${join(pluginDir, "hooks", "hooks.json")} (regenerated)`,
  `  state:   ${agentDir} (config + shadows)`,
  `  skills:  ${copyTarget} → loads as pi-shadow-mind@skills-dir`,
  `  marker:  ${markerPath}`,
  "Next: restart Claude Code (or /reload-plugins). Shadow Minds activate automatically.",
  `       /shadow status to verify.`,
].join("\n"));