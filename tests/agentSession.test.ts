import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentResumeCommand,
  buildAgentResumeCommandParts,
  detectRestorableAgentCommand,
  fallbackCommandForGeneratedAgentResume,
  normalizeAgentSessionId,
  isAgentResumeCommandForBinding,
  isAgentSessionEndEvent,
  sanitizeAgentBaseCommand,
  sanitizeAgentBaseArgv,
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

test("agent base command sanitizer strips dangerous-equivalent options", () => {
  assert.deepEqual(
    sanitizeAgentBaseCommand(
      "codex",
      "codex --sandbox danger-full-access --ask-for-approval never --profile work",
    )?.argv,
    ["codex", "--profile", "work"],
  );
  assert.equal(
    buildAgentResumeCommand(
      "codex",
      "11111111-2222-3333-4444-555555555555",
      false,
      "codex --sandbox danger-full-access --ask-for-approval never --profile work",
    ),
    "codex --profile work resume 11111111-2222-3333-4444-555555555555",
  );
  assert.deepEqual(
    sanitizeAgentBaseCommand(
      "claude",
      "claude --permission-mode bypassPermissions --model sonnet",
    )?.argv,
    ["claude", "--model", "sonnet"],
  );
});

test("agent base command sanitizer drops arbitrary Codex config overrides", () => {
  assert.deepEqual(
    sanitizeAgentBaseCommand(
      "codex",
      "codex -c approval_policy='never' --config sandbox_mode='danger-full-access' --profile work",
    )?.argv,
    ["codex", "--profile", "work"],
  );
  assert.deepEqual(
    sanitizeAgentBaseCommand(
      "codex",
      "codex --config=model_reasoning_effort=high --model gpt-5.5",
    )?.argv,
    ["codex", "--model", "gpt-5.5"],
  );
  assert.equal(
    buildAgentResumeCommand(
      "codex",
      "11111111-2222-3333-4444-555555555555",
      false,
      "codex -c approval_policy='never' --profile work",
    ),
    "codex --profile work resume 11111111-2222-3333-4444-555555555555",
  );
});

test("agent base command sanitizer rejects prompts, wrappers, and noninteractive subcommands", () => {
  assert.equal(sanitizeAgentBaseCommand("codex", "codex exec 'run tests'"), undefined);
  assert.equal(sanitizeAgentBaseCommand("codex", "codex 'fix tests'"), undefined);
  assert.equal(sanitizeAgentBaseCommand("codex", "bash -lc codex"), undefined);
  assert.equal(sanitizeAgentBaseCommand("claude", "claude --print 'hello'"), undefined);
  assert.equal(sanitizeAgentBaseCommand("claude", "claude auth"), undefined);
});

test("agent base argv is preferred over reparsing command strings", () => {
  assert.deepEqual(
    sanitizeAgentBaseArgv("codex", ["/tools/my codex/codex", "--profile", "work"])?.argv,
    ["/tools/my codex/codex", "--profile", "work"],
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

test("agent session end event detection accepts known spellings", () => {
  assert.equal(isAgentSessionEndEvent("SessionEnd"), true);
  assert.equal(isAgentSessionEndEvent("session-end"), true);
  assert.equal(isAgentSessionEndEvent("session_end"), true);
  assert.equal(isAgentSessionEndEvent("Stop"), false);
  assert.equal(isAgentSessionEndEvent(undefined), false);
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
  assert.equal(
    fallbackCommandForGeneratedAgentResume("codex resume --profile work --last"),
    undefined,
  );
  assert.equal(fallbackCommandForGeneratedAgentResume("codex resume --last"), undefined);
  assert.equal(fallbackCommandForGeneratedAgentResume("codex resume --help"), undefined);
  assert.equal(fallbackCommandForGeneratedAgentResume("claude --resume"), undefined);
});
