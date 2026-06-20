import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentResumeCommand,
  detectRestorableAgentCommand,
  isAgentResumeCommandForBinding,
} from "../src/utils/agentSession.ts";

test("buildAgentResumeCommand builds Codex and Claude resume commands", () => {
  assert.equal(
    buildAgentResumeCommand("codex", "11111111-2222-3333-4444-555555555555", false),
    "codex resume 11111111-2222-3333-4444-555555555555",
  );
  assert.equal(
    buildAgentResumeCommand("claude", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", false),
    "claude --resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  );
});

test("buildAgentResumeCommand adds per-agent dangerous resume flags", () => {
  assert.equal(
    buildAgentResumeCommand("codex", "11111111-2222-3333-4444-555555555555", true),
    "codex resume --dangerously-bypass-approvals-and-sandbox 11111111-2222-3333-4444-555555555555",
  );
  assert.equal(
    buildAgentResumeCommand("claude", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", true),
    "claude --dangerously-skip-permissions --resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  );
});

test("detectRestorableAgentCommand recognizes direct agent commands only", () => {
  assert.equal(detectRestorableAgentCommand("codex"), "codex");
  assert.equal(detectRestorableAgentCommand("/usr/bin/claude --resume abc"), "claude");
  assert.equal(detectRestorableAgentCommand("ssh host codex"), undefined);
  assert.equal(detectRestorableAgentCommand(undefined), undefined);
});

test("isAgentResumeCommandForBinding matches generated safe and dangerous commands", () => {
  const binding = {
    kind: "codex" as const,
    sessionId: "11111111-2222-3333-4444-555555555555",
  };
  assert.equal(
    isAgentResumeCommandForBinding(
      "codex resume 11111111-2222-3333-4444-555555555555",
      binding,
    ),
    true,
  );
  assert.equal(
    isAgentResumeCommandForBinding(
      "codex resume --dangerously-bypass-approvals-and-sandbox 11111111-2222-3333-4444-555555555555",
      binding,
    ),
    true,
  );
  assert.equal(isAgentResumeCommandForBinding("codex", binding), false);
});
