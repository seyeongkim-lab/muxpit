import test from "node:test";
import assert from "node:assert/strict";

import { buildAiRemoteCommand } from "../src/utils/aiRemoteCommand.ts";

test("AI remote command launches through the user's configured login shell", () => {
  const command = buildAiRemoteCommand("claude --dangerously-skip-permissions");

  assert.match(command, /^\/bin\/sh -lc /);
  assert.match(command, /\$\{SHELL:-\/bin\/sh\}/);
  assert.match(command, /claude --dangerously-skip-permissions/);
  assert.doesNotMatch(command, /bash -lc/);
  assert.doesNotMatch(command, /exec bash -l/);
});
