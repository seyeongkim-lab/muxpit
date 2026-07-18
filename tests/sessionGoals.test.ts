import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  encodeSessionGoal,
  parseSessionGoalsMessage,
  sessionGoalKey,
} from "../src/mobile/agentProtocol.ts";

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8");

test("goal keys pair provider and session id", () => {
  assert.equal(sessionGoalKey("claude", "abc-123"), "claude:abc-123");
});

test("encoded goals round-trip through the host helper format", () => {
  const goal = { text: "로그인 버그 수정", status: "active" as const, updatedAt: 1752835000 };
  const decoded = JSON.parse(Buffer.from(encodeSessionGoal(goal), "base64").toString("utf8"));
  assert.deepEqual(decoded, goal);
});

test("parseSessionGoalsMessage accepts muxpit_goals and drops malformed entries", () => {
  const goals = parseSessionGoalsMessage({
    type: "muxpit_goals",
    goals: {
      "claude:a": { text: "배포 준비", status: "done", updatedAt: 5 },
      "codex:b": { text: "리팩토링", status: "unknown", updatedAt: "x" },
      "gemini:c": { text: "" },
      "copilot:d": "not-an-object",
    },
  });
  assert.deepEqual(goals, {
    "claude:a": { text: "배포 준비", status: "done", updatedAt: 5 },
    "codex:b": { text: "리팩토링", status: "active", updatedAt: 0 },
  });
});

test("parseSessionGoalsMessage ignores other message types", () => {
  assert.equal(parseSessionGoalsMessage({ type: "muxpit_sessions", sessions: [] }), null);
  assert.equal(parseSessionGoalsMessage({ type: "muxpit_goals" }), null);
});

test("goals flow is wired end to end on both surfaces", () => {
  const script = read("../src-tauri/scripts/claude_sessions.py");
  assert.match(script, /muxpit_goals/);
  assert.match(script, /goal-set/);
  assert.match(script, /goal-delete/);
  assert.match(script, /os\.replace\(tmp_path, GOALS_PATH\)/);

  const desktopRust = read("../src-tauri/src/desktop_agent.rs");
  assert.match(desktopRust, /pub fn desktop_session_goals\(/);
  assert.match(desktopRust, /pub fn desktop_session_goal_set\(/);
  assert.match(desktopRust, /pub fn desktop_session_goal_delete\(/);

  const mobileRust = read("../src-tauri/src/mobile_agent.rs");
  assert.match(mobileRust, /pub async fn mobile_session_goals\(/);
  assert.match(mobileRust, /pub async fn mobile_session_goal_set\(/);
  assert.match(mobileRust, /pub async fn mobile_session_goal_delete\(/);

  const workbench = read("../src/components/AgentWorkbenchPanel.tsx");
  assert.match(workbench, /parseSessionGoalsMessage\(message\)/);
  assert.match(workbench, /requestGoalChange/);
  assert.match(workbench, /agent-session-goal/);

  const mobile = read("../src/mobile/MobileApp.tsx");
  assert.match(mobile, /parseSessionGoalsMessage\(message\)/);
  assert.match(mobile, /requestGoalChange/);
  assert.match(mobile, /session-goal-bar/);
});
