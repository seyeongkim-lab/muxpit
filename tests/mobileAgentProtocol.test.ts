import test from "node:test";
import assert from "node:assert/strict";

import {
  JsonLineDecoder,
  composerAction,
  normalizeClaudeMessage,
  normalizeClaudeHistoryMessage,
  normalizeCodexMessage,
} from "../src/mobile/agentProtocol.ts";

test("JSON line decoder preserves split UTF-8 chunks", () => {
  const decoder = new JsonLineDecoder();
  const bytes = new TextEncoder().encode('{"text":"한글"}\n{"done":true}\n');

  assert.deepEqual(decoder.push(bytes.slice(0, 13)), []);
  assert.deepEqual(decoder.push(bytes.slice(13)), [
    '{"text":"한글"}',
    '{"done":true}',
  ]);
});

test("Codex notifications become structured mobile events", () => {
  assert.deepEqual(
    normalizeCodexMessage({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    }),
    [{ type: "turnStarted", sessionId: "thread-1", turnId: "turn-1" }],
  );

  assert.deepEqual(
    normalizeCodexMessage({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "수정 중" },
    }),
    [{
      type: "messageDelta",
      sessionId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: "수정 중",
    }],
  );
});

test("Codex approval request keeps request id and command", () => {
  assert.deepEqual(
    normalizeCodexMessage({
      id: 19,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-2",
        command: "pnpm test",
        reason: "Run tests",
      },
    }),
    [{
      type: "approvalRequested",
      requestId: 19,
      sessionId: "thread-1",
      turnId: "turn-1",
      itemId: "item-2",
      title: "pnpm test",
      detail: "Run tests",
    }],
  );
});

test("Claude stream messages become text, tool, and completion events", () => {
  assert.deepEqual(
    normalizeClaudeMessage({
      type: "assistant",
      session_id: "session-1",
      message: {
        content: [
          { type: "text", text: "확인했습니다." },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pnpm test" } },
        ],
      },
    }),
    [
      { type: "messageCompleted", sessionId: "session-1", text: "확인했습니다." },
      {
        type: "toolStarted",
        sessionId: "session-1",
        itemId: "tool-1",
        title: "Bash",
        detail: "pnpm test",
      },
    ],
  );

  assert.deepEqual(
    normalizeClaudeMessage({ type: "result", session_id: "session-1", subtype: "success" }),
    [{ type: "turnCompleted", sessionId: "session-1", status: "completed" }],
  );
});

test("Claude history payload becomes a loaded mobile session", () => {
  const session = {
    id: "session-1",
    title: "Fix Android client",
    cwd: "/home/me/project",
    updatedAt: 1_752_500_000,
    provider: "claude" as const,
  };
  const items = [
    { id: "user-1", kind: "user" as const, text: "Fix the client" },
    { id: "tool-1", kind: "tool" as const, title: "Bash", text: "pnpm test" },
  ];

  assert.deepEqual(
    normalizeClaudeHistoryMessage({
      type: "wmux_claude_session",
      session,
      items,
    }),
    [{ type: "sessionLoaded", session, items }],
  );
});

test("composer action distinguishes send, steer, and queue", () => {
  assert.equal(composerAction(false, false), "send");
  assert.equal(composerAction(true, false), "steer");
  assert.equal(composerAction(true, true), "queue");
});
