import test from "node:test";
import assert from "node:assert/strict";

import type { WorkspaceInfo } from "../src/hooks/useWorkspaceInfo.ts";
import type { LeafNode, Workspace } from "../src/stores/workspace.ts";
import { buildWorkspaceTabView } from "../src/utils/workspaceTabTitle.ts";

const makeWorkspace = (leafPatch: Partial<LeafNode> = {}): Workspace => {
  const leaf: LeafNode = {
    type: "leaf",
    id: "leaf",
    ptyId: null,
    ...leafPatch,
  };
  return {
    id: "ws",
    name: "Shell 1",
    nameSource: "auto",
    layout: leaf,
    focusedLeafId: leaf.id,
  };
};

const makeInfo = (patch: Partial<WorkspaceInfo>): WorkspaceInfo => ({
  cwd: "",
  gitBranch: null,
  gitDirty: false,
  ports: [],
  processName: null,
  command: null,
  agent: null,
  memoryBytes: 0,
  cpuPercent: 0,
  descendantCount: 0,
  terminalTitle: null,
  aiStatusLabel: null,
  aiStatusKind: null,
  aiStatusUpdatedAt: null,
  ...patch,
});

test("workspace tab title uses a useful OSC terminal title first", () => {
  const view = buildWorkspaceTabView(
    makeWorkspace(),
    makeInfo({ cwd: "/home/me/wmux", terminalTitle: "nvim package.json" }),
  );

  assert.equal(view.title, "nvim package.json");
  assert.equal(view.detail, "wmux");
});

test("workspace tab title shows AI agent and cwd", () => {
  const view = buildWorkspaceTabView(
    makeWorkspace({ aiKind: "codex" }),
    makeInfo({ cwd: "/home/me/wmux", processName: "codex" }),
  );

  assert.equal(view.title, "codex: wmux");
  assert.equal(view.detail, "codex");
});

test("workspace tab title shows AI terminal status before cwd", () => {
  const view = buildWorkspaceTabView(
    makeWorkspace({ aiKind: "codex" }),
    makeInfo({
      cwd: "/home/me/wmux",
      processName: "codex",
      aiStatusLabel: "permission: cargo check",
      aiStatusKind: "ready",
      aiStatusUpdatedAt: 100,
    }),
  );

  assert.equal(view.title, "codex: permission: cargo check");
  assert.equal(view.detail, "wmux");
  assert.equal(view.statusKind, "ready");
});

test("workspace tab title shows SSH target", () => {
  const view = buildWorkspaceTabView(makeWorkspace({ command: "ssh me@host" }));

  assert.equal(view.title, "me@host");
});

test("workspace tab title shows active tmux session name", () => {
  const view = buildWorkspaceTabView(
    makeWorkspace({ command: "ssh me@host", tmuxSession: "wmux-host" }),
    undefined,
    { sshCommand: "ssh me@host", wrapperSession: "wmux-host", activeSession: "$1" },
    [{ id: "$1", name: "work", attached: true, windows: 1, activity: 0 }],
  );

  assert.equal(view.title, "tmux: work");
  assert.equal(view.detail, "me@host");
});

test("workspace tab title shows foreground process and cwd", () => {
  const view = buildWorkspaceTabView(
    makeWorkspace(),
    makeInfo({ cwd: "/repo/app", processName: "node", command: "node server.js" }),
  );

  assert.equal(view.title, "node: app");
  assert.equal(view.detail, "node server.js");
});
