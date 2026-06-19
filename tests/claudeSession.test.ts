import test from "node:test";
import assert from "node:assert/strict";

import { buildClaudeResumeRemoteCommand } from "../src/utils/claudeSession.ts";

test("claude resume command uses cwd only when it is known", () => {
  assert.equal(
    buildClaudeResumeRemoteCommand("/home/me/my-app", "session-1"),
    "cd /home/me/my-app && claude --resume session-1",
  );
  assert.equal(
    buildClaudeResumeRemoteCommand(undefined, "session-1"),
    "claude --resume session-1",
  );
});

test("claude resume command quotes paths and session ids", () => {
  assert.equal(
    buildClaudeResumeRemoteCommand("/home/me/it's app", "session one"),
    "cd '/home/me/it'\\''s app' && claude --resume 'session one'",
  );
});
