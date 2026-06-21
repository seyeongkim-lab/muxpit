import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentResumeCommand,
  buildAgentResumeCommandParts,
  detectRestorableAgentCommand,
  fallbackCommandForGeneratedAgentResume,
  normalizeAgentSessionId,
  isAgentResumeCommandForBinding,
  stripAgentDangerousFlags,
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
  assert.equal(
    buildAgentResumeCommand("codex", "11111111-2222-3333-4444-555555555555", false, "/opt/bin/codex --profile work"),
    "/opt/bin/codex --profile work resume 11111111-2222-3333-4444-555555555555",
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

test("buildAgentResumeCommand strips dangerous flags from saved base commands", () => {
  assert.equal(
    buildAgentResumeCommand(
      "codex",
      "11111111-2222-3333-4444-555555555555",
      false,
      "codex --dangerously-bypass-approvals-and-sandbox --profile work",
    ),
    "codex --profile work resume 11111111-2222-3333-4444-555555555555",
  );
  assert.equal(
    buildAgentResumeCommand(
      "claude",
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      true,
      "claude --dangerously-skip-permissions --model sonnet",
    ),
    "claude --model sonnet --dangerously-skip-permissions --resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  );
  assert.deepEqual(
    buildAgentResumeCommandParts("codex", "11111111-2222-3333-4444-555555555555", false, "codex"),
    ["codex", "resume", "11111111-2222-3333-4444-555555555555"],
  );
  assert.equal(
    stripAgentDangerousFlags("codex", "codex --dangerously-bypass-approvals-and-sandbox --profile work"),
    "codex --profile work",
  );
});

test("detectRestorableAgentCommand recognizes direct agent commands only", () => {
  assert.equal(detectRestorableAgentCommand("codex"), "codex");
  assert.equal(detectRestorableAgentCommand("/usr/bin/claude --resume abc"), "claude");
  assert.equal(detectRestorableAgentCommand("C:\\Tools\\codex.exe resume abc"), "codex");
  assert.equal(detectRestorableAgentCommand("\"C:\\Program Files\\Claude\\claude.cmd\""), "claude");
  assert.equal(detectRestorableAgentCommand("ssh host codex"), undefined);
  assert.equal(detectRestorableAgentCommand(undefined), undefined);
});

test("agent session ids reject option-shaped or shell-split values", () => {
  assert.equal(normalizeAgentSessionId("11111111-2222-3333-4444-555555555555"), "11111111-2222-3333-4444-555555555555");
  assert.equal(normalizeAgentSessionId("--dangerously-bypass-approvals-and-sandbox"), undefined);
  assert.equal(normalizeAgentSessionId("--last"), undefined);
  assert.equal(normalizeAgentSessionId("session with spaces"), undefined);
  assert.equal(normalizeAgentSessionId("abc&calc"), undefined);
  assert.equal(normalizeAgentSessionId("abc;rm"), undefined);
  assert.equal(normalizeAgentSessionId("abc'quote"), undefined);
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
  assert.equal(
    fallbackCommandForGeneratedAgentResume("codex resume --dangerously-bypass-approvals-and-sandbox 11111111-2222-3333-4444-555555555555"),
    "codex",
  );
  assert.equal(
    fallbackCommandForGeneratedAgentResume("claude --dangerously-skip-permissions --resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    "claude",
  );
  assert.equal(fallbackCommandForGeneratedAgentResume("codex resume --last"), undefined);
  assert.equal(fallbackCommandForGeneratedAgentResume("codex resume --help"), undefined);
  assert.equal(fallbackCommandForGeneratedAgentResume("claude --resume"), undefined);
});
