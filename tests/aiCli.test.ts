import test from "node:test";
import assert from "node:assert/strict";

import { buildAiRemoteCommand } from "../src/utils/aiRemoteCommand.ts";

test("AI remote command launches through the user's configured login shell", () => {
  const command = buildAiRemoteCommand("claude --dangerously-skip-permissions");

  assert.match(command, /^\/bin\/sh -lc /);
  assert.match(command, /\$\{SHELL:-\/bin\/sh\}/);
  assert.match(command, /case "\$shell" in/);
  assert.match(command, /\*\) wmux_shell=\/bin\/sh/);
  assert.match(command, /claude --dangerously-skip-permissions/);
  assert.doesNotMatch(command, /bash -lc/);
  assert.doesNotMatch(command, /exec bash -l/);
});

test("AI remote command changes to the reported absolute cwd before launch", () => {
  const command = buildAiRemoteCommand("codex", "/home/me/project");

  assert.match(command, /cd \/home\/me\/project && codex/);
});

test("AI remote command ignores a relative cwd", () => {
  const command = buildAiRemoteCommand("codex", "projects/wmux");

  assert.doesNotMatch(command, /cd projects\/wmux/);
});
