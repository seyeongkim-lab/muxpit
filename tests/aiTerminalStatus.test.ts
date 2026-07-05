import test from "node:test";
import assert from "node:assert/strict";

import {
  aiStatusFromHookNotification,
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
