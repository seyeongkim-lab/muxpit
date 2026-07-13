import assert from "node:assert/strict";
import test from "node:test";
import {
  executeControlRequest,
  type ControlRuntime,
} from "../src/utils/controlRequest.ts";
import type { Workspace } from "../src/stores/workspace.ts";

const workspace: Workspace = {
  id: "ws-1",
  name: "Project",
  nameSource: "manual",
  focusedLeafId: "pane-1",
  layout: {
    type: "leaf",
    id: "pane-1",
    ptyId: 7,
    aiKind: "codex",
  },
};

const runtime = (overrides: Partial<ControlRuntime> = {}): ControlRuntime => ({
  getWorkspaces: () => ({ workspaces: [workspace], activeId: "ws-1" }),
  getLeafCwd: () => "/work/project",
  split: () => "pane-2",
  focus: () => {},
  write: async () => {},
  readVisibleText: () => ["line one", "line two"],
  openBrowser: () => "browser-1",
  browser: async () => ({}),
  setBrowserUrl: () => {},
  ...overrides,
});

test("identify resolves the requested wmux surface", async () => {
  const result = await executeControlRequest({
    requestId: "request-1",
    action: "identify",
    params: { workspace_id: "ws-1", surface_id: "pane-1" },
  }, runtime());

  assert.deepEqual(result, {
    workspaceId: "ws-1",
    workspaceName: "Project",
    surfaceId: "pane-1",
    surfaceType: "terminal",
    focused: true,
    active: true,
    cwd: "/work/project",
    aiKind: "codex",
  });
});

test("split focuses the new surface", async () => {
  const calls: string[] = [];
  const result = await executeControlRequest({
    requestId: "request-2",
    action: "split",
    params: {
      workspace_id: "ws-1",
      surface_id: "pane-1",
      direction: "horizontal",
      command: "codex",
    },
  }, runtime({
    split: (_workspaceId, _surfaceId, direction, command) => {
      calls.push(`${direction}:${command}`);
      return "pane-2";
    },
    focus: (workspaceId, surfaceId) => calls.push(`${workspaceId}:${surfaceId}`),
  }));

  assert.deepEqual(result, { workspaceId: "ws-1", surfaceId: "pane-2" });
  assert.deepEqual(calls, ["horizontal:codex", "ws-1:pane-2"]);
});

test("spawn-subagent records parent surface and label", async () => {
  const calls: unknown[] = [];
  const result = await executeControlRequest({
    requestId: "request-subagent",
    action: "spawn-subagent",
    params: {
      workspace_id: "ws-1",
      surface_id: "pane-1",
      origin_surface_id: "pane-1",
      direction: "vertical",
      command: "codex",
      label: "reviewer",
    },
  }, runtime({
    split: (_workspaceId, _surfaceId, _direction, _command, metadata) => {
      calls.push(metadata);
      return "pane-subagent";
    },
    focus: () => {},
  }));

  assert.deepEqual(result, { workspaceId: "ws-1", surfaceId: "pane-subagent" });
  assert.deepEqual(calls, [{
    agentRole: "subagent",
    parentSurfaceId: "pane-1",
    agentLabel: "reviewer",
  }]);
});

test("read-screen returns visible terminal text", async () => {
  const result = await executeControlRequest({
    requestId: "request-3",
    action: "read-screen",
    params: { workspace_id: "ws-1", surface_id: "pane-1", rows: 10 },
  }, runtime());

  assert.deepEqual(result, {
    workspaceId: "ws-1",
    surfaceId: "pane-1",
    text: "line one\nline two",
  });
});

test("send-text writes to the requested terminal", async () => {
  const writes: string[] = [];
  const result = await executeControlRequest({
    requestId: "request-4",
    action: "send-text",
    params: { workspace_id: "ws-1", surface_id: "pane-1", text: "npm test\r" },
  }, runtime({
    write: async (surfaceId, text) => {
      writes.push(`${surfaceId}:${text}`);
    },
  }));

  assert.deepEqual(result, { workspaceId: "ws-1", surfaceId: "pane-1" });
  assert.deepEqual(writes, ["pane-1:npm test\r"]);
});

test("list-surfaces returns workspace surface metadata", async () => {
  const result = await executeControlRequest({
    requestId: "request-5",
    action: "list-surfaces",
    params: { workspace_id: "ws-1" },
  }, runtime());

  assert.deepEqual(result, [{
    workspaceId: "ws-1",
    workspaceName: "Project",
    surfaceId: "pane-1",
    surfaceType: "terminal",
    focused: true,
    active: true,
    cwd: "/work/project",
    aiKind: "codex",
  }]);
});

test("browser snapshot selects the workspace browser from a terminal", async () => {
  const browserWorkspace: Workspace = {
    ...workspace,
    layout: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        workspace.layout,
        { type: "browser", id: "browser-1", url: "https://example.com" },
      ],
    },
  };
  const calls: unknown[] = [];

  const result = await executeControlRequest({
    requestId: "request-browser-snapshot",
    action: "browser-snapshot",
    params: { workspace_id: "ws-1", surface_id: "pane-1" },
  }, runtime({
    getWorkspaces: () => ({ workspaces: [browserWorkspace], activeId: "ws-1" }),
    browser: async (surfaceId, action, value) => {
      calls.push([surfaceId, action, value]);
      return { title: "Example", url: "https://example.com", text: "Hello" };
    },
  }));

  assert.deepEqual(calls, [["browser-1", "snapshot", undefined]]);
  assert.deepEqual(result, {
    title: "Example",
    url: "https://example.com",
    text: "Hello",
  });
});

test("browser open creates and focuses a browser beside the terminal", async () => {
  const calls: unknown[] = [];
  const result = await executeControlRequest({
    requestId: "request-browser-open",
    action: "browser-open",
    params: {
      workspace_id: "ws-1",
      surface_id: "pane-1",
      url: "https://example.com",
    },
  }, runtime({
    openBrowser: (workspaceId, surfaceId, url) => {
      calls.push([workspaceId, surfaceId, url]);
      return "browser-2";
    },
    focus: (workspaceId, surfaceId) => calls.push([workspaceId, surfaceId]),
  }));

  assert.deepEqual(calls, [
    ["ws-1", "pane-1", "https://example.com"],
    ["ws-1", "browser-2"],
  ]);
  assert.deepEqual(result, { workspaceId: "ws-1", surfaceId: "browser-2" });
});

test("browser navigate updates the persisted browser URL", async () => {
  const browserWorkspace: Workspace = {
    ...workspace,
    focusedLeafId: "browser-1",
    layout: { type: "browser", id: "browser-1", url: "https://old.example" },
  };
  const updates: string[] = [];

  const result = await executeControlRequest({
    requestId: "request-browser-navigate",
    action: "browser-navigate",
    params: {
      workspace_id: "ws-1",
      surface_id: "browser-1",
      url: "https://example.com/docs",
    },
  }, runtime({
    getWorkspaces: () => ({ workspaces: [browserWorkspace], activeId: "ws-1" }),
    browser: async () => ({ url: "https://example.com/docs" }),
    setBrowserUrl: (workspaceId, surfaceId, url) => {
      updates.push(`${workspaceId}:${surfaceId}:${url}`);
    },
  }));

  assert.deepEqual(result, { url: "https://example.com/docs" });
  assert.deepEqual(updates, ["ws-1:browser-1:https://example.com/docs"]);
});

test("browser command rejects a workspace without a browser pane", async () => {
  await assert.rejects(
    executeControlRequest({
      requestId: "request-browser-missing",
      action: "browser-console",
      params: { workspace_id: "ws-1", surface_id: "pane-1" },
    }, runtime()),
    /Browser surface not found/,
  );
});
