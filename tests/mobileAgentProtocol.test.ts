import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVE_BADGE_TTL_MS,
  ClaudeStreamNormalizer,
  JsonLineDecoder,
  composerAction,
  isSessionActive,
  markSessionActivity,
  normalizeClaudeMessage,
  normalizeClaudeHistoryMessage,
  normalizeCodexMessage,
  reconcileAgentSessions,
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

test("Codex thread status reports active and waiting sessions", () => {
  assert.deepEqual(normalizeCodexMessage({
    method: "thread/status/changed",
    params: {
      threadId: "thread-1",
      status: { type: "active", activeFlags: ["waitingOnUserInput"] },
    },
  }), [{
    type: "sessionStatus",
    sessionId: "thread-1",
    running: true,
    waiting: true,
  }]);

  assert.deepEqual(normalizeCodexMessage({
    id: 3,
    result: {
      thread: {
        id: "thread-1",
        name: "Active task",
        cwd: "/project",
        updatedAt: 1_752_500_000,
        status: { type: "active", activeFlags: [] },
        turns: [{ id: "turn-1", status: "inProgress", items: [] }],
      },
    },
  }), [
    {
      type: "sessionLoaded",
      session: {
        id: "thread-1",
        title: "Active task",
        cwd: "/project",
        updatedAt: 1_752_500_000,
        provider: "codex",
      },
      items: [],
    },
    {
      type: "sessionStatus",
      sessionId: "thread-1",
      running: true,
      waiting: false,
      turnId: "turn-1",
    },
  ]);
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
        tool: { name: "Bash", input: { command: "pnpm test" } },
      },
    ],
  );

  assert.deepEqual(
    normalizeClaudeMessage({ type: "result", session_id: "session-1", subtype: "success" }),
    [{ type: "turnCompleted", sessionId: "session-1", status: "completed" }],
  );

  assert.deepEqual(
    normalizeClaudeMessage({
      type: "result",
      session_id: "session-1",
      subtype: "error_during_execution",
      is_error: true,
      result: "No conversation found with session ID: session-1",
    }),
    [
      { type: "turnCompleted", sessionId: "session-1", status: "failed" },
      {
        type: "error",
        sessionId: "session-1",
        message: "No conversation found with session ID: session-1",
      },
    ],
  );

  assert.deepEqual(
    normalizeClaudeMessage({
      type: "result",
      session_id: "session-1",
      subtype: "error_during_execution",
      is_error: true,
    }),
    [
      { type: "turnCompleted", sessionId: "session-1", status: "failed" },
      {
        type: "error",
        sessionId: "session-1",
        message: "Claude turn failed (error_during_execution)",
      },
    ],
  );
});

test("Claude partial stream reuses the message id for delta and completion", () => {
  const normalizer = new ClaudeStreamNormalizer();

  assert.deepEqual(normalizer.receive({
    type: "stream_event",
    session_id: "session-1",
    event: {
      type: "message_start",
      message: { id: "message-1" },
    },
  }), []);
  assert.deepEqual(normalizer.receive({
    type: "stream_event",
    session_id: "session-1",
    event: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "진행 중" },
    },
  }), [{
    type: "messageDelta",
    sessionId: "session-1",
    turnId: "message-1",
    itemId: "message-1",
    text: "진행 중",
  }]);
  assert.deepEqual(normalizer.receive({
    type: "assistant",
    session_id: "session-1",
    message: {
      id: "message-1",
      content: [{ type: "text", text: "진행 중" }],
    },
  }), [{
    type: "messageCompleted",
    sessionId: "session-1",
    itemId: "message-1",
    text: "진행 중",
  }]);
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
      type: "muxpit_claude_session",
      session,
      items,
    }),
    [{ type: "sessionLoaded", session, items }],
  );
});

test("Claude history errors stay attached to the requested session", () => {
  assert.deepEqual(
    normalizeClaudeHistoryMessage({ type: "muxpit_error", message: "not found" }, "session-2"),
    [{ type: "error", message: "not found", sessionId: "session-2" }],
  );
});

test("Claude assistant text blocks complete one streamed message", () => {
  assert.deepEqual(normalizeClaudeMessage({
    type: "assistant",
    session_id: "session-1",
    message: {
      id: "message-1",
      content: [
        { type: "text", text: "first" },
        { type: "tool_use", id: "tool-1", name: "Read", input: { path: "a" } },
        { type: "text", text: "second" },
      ],
    },
  }), [
    {
      type: "messageCompleted",
      sessionId: "session-1",
      itemId: "message-1",
      text: "firstsecond",
    },
    {
      type: "toolStarted",
      sessionId: "session-1",
      itemId: "tool-1",
      title: "Read",
      detail: "a",
      tool: { name: "Read", input: { path: "a" } },
    },
  ]);
});

test("composer action distinguishes send, steer, and queue", () => {
  assert.equal(composerAction(false, false), "send");
  assert.equal(composerAction(true, false), "steer");
  assert.equal(composerAction(true, true), "queue");
});

test("reconciled session lists keep active and running sessions the lister missed", () => {
  const fresh = [
    { id: "listed-1", title: "Listed", updatedAt: 100, provider: "claude" as const },
  ];
  const current = [
    { id: "active-new", title: "Just created", updatedAt: 200, provider: "claude" as const },
    { id: "running-1", title: "Running", updatedAt: 150, provider: "claude" as const },
    { id: "stale-1", title: "Deleted on host", updatedAt: 50, provider: "claude" as const },
  ];

  assert.deepEqual(
    reconcileAgentSessions(fresh, current, ["active-new", "running-1"]).map((session) => session.id),
    ["active-new", "running-1", "listed-1"],
  );
});

test("host activity flags become client expiries and decay without refreshes", () => {
  const marked = markSessionActivity([
    { id: "busy", title: "Busy", provider: "claude" as const, active: true },
    { id: "idle", title: "Idle", provider: "claude" as const, active: false },
  ], 1_000_000);

  assert.equal(marked[0].activeUntil, 1_000_000 + ACTIVE_BADGE_TTL_MS);
  assert.equal(marked[1].activeUntil, undefined);
  assert.equal(isSessionActive(marked[0], 1_000_000 + ACTIVE_BADGE_TTL_MS - 1), true);
  assert.equal(isSessionActive(marked[0], 1_000_000 + ACTIVE_BADGE_TTL_MS), false);
  assert.equal(isSessionActive(marked[1], 1_000_000), false);
});

test("reconciled session lists prefer the fresh entry for kept ids", () => {
  const fresh = [
    { id: "session-1", title: "Authoritative", cwd: "/srv", updatedAt: 300, provider: "claude" as const },
  ];
  const current = [
    { id: "session-1", title: "Stub", updatedAt: 200, provider: "claude" as const },
  ];

  assert.deepEqual(
    reconcileAgentSessions(fresh, current, ["session-1"]),
    fresh,
  );
});
