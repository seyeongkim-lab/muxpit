import test from "node:test";
import assert from "node:assert/strict";

import {
  aiStatusFromAgentSessionEvent,
  aiStatusFromHookNotification,
  detectAiAgentName,
  parseAiTerminalStatus,
} from "../src/utils/aiTerminalStatus.ts";

test("AI terminal status parser extracts active work from visible TUI lines", () => {
  const status = parseAiTerminalStatus([
    "Codex",
    "  thinking",
    "  running cargo test",
  ], 123);

  assert.deepEqual(status, {
    label: "running cargo test",
    kind: "active",
    updatedAt: 123,
  });
});

test("AI terminal status parser treats permission prompts as ready", () => {
  const status = parseAiTerminalStatus([
    "Codex",
    "\u25cf Permission requested: shell_command",
  ], 456);

  assert.deepEqual(status, {
    label: "permission: shell_command",
    kind: "ready",
    updatedAt: 456,
  });
});

test("AI hook notifications map permission requests to ready status", () => {
  const status = aiStatusFromHookNotification(
    "codex",
    "PermissionRequest",
    "Permission requested: cargo check",
    789,
  );

  assert.deepEqual(status, {
    label: "permission: cargo check",
    kind: "ready",
    updatedAt: 789,
  });
});

test("AI session prompt events map prompt text to active status", () => {
  const status = aiStatusFromAgentSessionEvent(
    "codex",
    "UserPromptSubmit",
    "Implement tab status for AI work",
    900,
  );

  assert.deepEqual(status, {
    label: "Implement tab status for AI work",
    kind: "active",
    updatedAt: 900,
  });
});

test("AI terminal status parser can fall back to last visible content", () => {
  const status = parseAiTerminalStatus([
    "Codex",
    "Reviewing src/App.tsx and terminal hooks",
  ], 901, { allowFallback: true });

  assert.deepEqual(status, {
    label: "Reviewing src/App.tsx and terminal hooks",
    kind: "active",
    updatedAt: 901,
  });
});

test("AI agent detection handles wrappers and commands", () => {
  assert.equal(detectAiAgentName("node", "/home/me/.npm/bin/codex.js"), "codex");
  assert.equal(detectAiAgentName("claude-code.cmd"), "claude");
  assert.equal(detectAiAgentName("bash", "echo codec"), null);
});
