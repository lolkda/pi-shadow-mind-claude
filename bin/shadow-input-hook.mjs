// UserPromptSubmit hook, background mode: new user input just advances the
// epoch. Background shadows keep running and their reports are drained by the
// next Stop; nothing is aborted and nothing is invalidated (Pi's result-batch
// semantics). Contract: always exit 0, empty stdout (30s budget).

import { readStdinJson, logDebug } from "./util.mjs";
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
    state.session(sessionId).epoch += 1;
    await state.save();
  } catch (inner) {
    log(`hook error: ${inner instanceof Error ? inner.message : String(inner)}`);
  }
}