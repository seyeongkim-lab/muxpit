import test from "node:test";
import assert from "node:assert/strict";

import {
  isAiCliCommand,
  shouldInjectShellHistoryHook,
  SHELL_HISTORY_HOOK,
} from "../src/utils/shellIntegration.ts";

const baseContext = {
  aiKind: undefined,
  spawnCommand: null,
  tmuxSession: undefined,
  isWindowsLocalShell: false,
  isPowerShellTarget: false,
};

test("shell history hook is injected for plain POSIX shells", () => {
  assert.equal(shouldInjectShellHistoryHook(baseContext), true);
  assert.match(SHELL_HISTORY_HOOK, /OSC|777|cmd|PROMPT_COMMAND/);
});

test("shell history hook skips panes where injection would be disruptive", () => {
  assert.equal(shouldInjectShellHistoryHook({ ...baseContext, aiKind: "claude" }), false);
  assert.equal(shouldInjectShellHistoryHook({ ...baseContext, spawnCommand: "ssh host claude" }), false);
  assert.equal(shouldInjectShellHistoryHook({ ...baseContext, tmuxSession: "wmux-host" }), false);
  assert.equal(shouldInjectShellHistoryHook({ ...baseContext, isWindowsLocalShell: true }), false);
  assert.equal(shouldInjectShellHistoryHook({ ...baseContext, spawnCommand: "pwsh", isPowerShellTarget: true }), false);
});

test("AI CLI command detection only matches command tokens", () => {
  assert.equal(isAiCliCommand("claude --resume abc"), true);
  assert.equal(isAiCliCommand("/usr/bin/codex"), true);
  assert.equal(isAiCliCommand("echo preclaude"), false);
});
