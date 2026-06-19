import test from "node:test";
import assert from "node:assert/strict";

import {
  buildShellHistoryHookContext,
  isAiCliCommand,
  resolveShellHistoryHookTarget,
  shouldInjectShellHistoryHook,
  SHELL_HISTORY_HOOK,
} from "../src/utils/shellIntegration.ts";

const baseContext = {
  aiKind: undefined,
  spawnCommand: null,
  tmuxSession: undefined,
  target: "local-posix" as const,
};

test("shell history hook is injected for plain POSIX shells", () => {
  assert.equal(shouldInjectShellHistoryHook(baseContext), true);
  assert.match(SHELL_HISTORY_HOOK, /OSC|777|cmd|PROMPT_COMMAND/);
});

test("shell history hook skips panes where injection would be disruptive", () => {
  assert.equal(shouldInjectShellHistoryHook({ ...baseContext, aiKind: "claude" }), false);
  assert.equal(shouldInjectShellHistoryHook({ ...baseContext, spawnCommand: "ssh host claude" }), false);
  assert.equal(shouldInjectShellHistoryHook({ ...baseContext, tmuxSession: "wmux-host" }), false);
  assert.equal(shouldInjectShellHistoryHook({ ...baseContext, target: "local-windows" }), false);
  assert.equal(shouldInjectShellHistoryHook({ ...baseContext, spawnCommand: "pwsh", target: "spawn-windows" }), false);
});

test("AI CLI command detection only matches command tokens", () => {
  assert.equal(isAiCliCommand("claude --resume abc"), true);
  assert.equal(isAiCliCommand("/usr/bin/codex"), true);
  assert.equal(isAiCliCommand("echo preclaude"), false);
});

test("shell history hook target resolution separates local and spawned shell families", () => {
  assert.equal(resolveShellHistoryHookTarget(null, "linux"), "local-posix");
  assert.equal(resolveShellHistoryHookTarget(null, "macos"), "local-posix");
  assert.equal(resolveShellHistoryHookTarget(null, "windows"), "local-windows");
  assert.equal(resolveShellHistoryHookTarget("ssh host", "linux"), "spawn-posix");
  assert.equal(resolveShellHistoryHookTarget("ssh host pwsh", "linux"), "spawn-windows");
  assert.equal(resolveShellHistoryHookTarget("pwsh", "windows"), "spawn-windows");
});

test("shell history hook context accepts an injected platform", () => {
  assert.deepEqual(buildShellHistoryHookContext(undefined, null, undefined, "windows"), {
    aiKind: undefined,
    spawnCommand: null,
    tmuxSession: undefined,
    target: "local-windows",
  });
});
