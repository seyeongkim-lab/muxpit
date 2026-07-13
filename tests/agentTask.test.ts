import test from "node:test";
import assert from "node:assert/strict";

import {
  agentTaskStatusFromEvent,
  attentionAgentTasks,
  reduceAgentTask,
  resolveAgentTaskTarget,
  type AgentTask,
} from "../src/utils/agentTask.ts";

const task = (status: AgentTask["status"]): AgentTask => ({
  id: "ws:pane",
  workspaceId: "ws",
  surfaceId: "pane",
  source: "codex",
  label: status,
  status,
  updatedAt: 1,
  acknowledged: false,
});

test("hook events map to task inbox states", () => {
  assert.equal(agentTaskStatusFromEvent("UserPromptSubmit"), "working");
  assert.equal(agentTaskStatusFromEvent("PermissionRequest"), "waiting");
  assert.equal(agentTaskStatusFromEvent("Stop"), "done");
  assert.equal(agentTaskStatusFromEvent("ErrorOccurred"), "error");
});

test("task updates replace a surface record and clear acknowledgement", () => {
  const existing = { ...task("done"), acknowledged: true };
  const next = reduceAgentTask([existing], {
    workspaceId: "ws",
    surfaceId: "pane",
    source: "codex",
    label: "needs approval",
    status: "waiting",
    updatedAt: 2,
  });

  assert.equal(next.length, 1);
  assert.equal(next[0].status, "waiting");
  assert.equal(next[0].acknowledged, false);
});

test("attention tasks omit working and acknowledged records", () => {
  const tasks = [
    task("working"),
    { ...task("waiting"), id: "wait", surfaceId: "wait", updatedAt: 3 },
    { ...task("done"), id: "done", surfaceId: "done", acknowledged: true },
  ];
  assert.deepEqual(attentionAgentTasks(tasks).map((item) => item.id), ["wait"]);
});

test("task targets resolve only to an existing workspace surface", () => {
  const workspaces = [
    {
      id: "ws",
      layout: {
        type: "split" as const,
        children: [
          { type: "leaf" as const, id: "left" },
          { type: "browser" as const, id: "browser" },
        ],
      },
    },
  ];

  assert.deepEqual(
    resolveAgentTaskTarget({ ...task("waiting"), surfaceId: "browser" }, workspaces),
    { workspaceId: "ws", surfaceId: "browser" },
  );
  assert.equal(
    resolveAgentTaskTarget({ ...task("waiting"), surfaceId: "missing" }, workspaces),
    null,
  );
  assert.equal(
    resolveAgentTaskTarget({ ...task("waiting"), workspaceId: "missing" }, workspaces),
    null,
  );
});
