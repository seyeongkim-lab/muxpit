import test from "node:test";
import assert from "node:assert/strict";

import type { LeafNode, Workspace } from "../src/stores/workspace.ts";
import {
  findTerminalAiKind,
  findTerminalCloneFromPtyId,
  findTerminalLeaf,
  findTerminalSpawnSpec,
  findTerminalTmuxSession,
  isLocalAgentSessionReportingSpawnSpec,
  isLocalTerminalLeaf,
  terminalLeafExists,
  terminalSpawnSpecFromLeaf,
} from "../src/utils/terminalSessionLayout.ts";

test("terminal spawn spec preserves parsed SSH tty mode", () => {
  const leaf: LeafNode = {
    type: "leaf",
    id: "leaf",
    ptyId: null,
    command: "ssh -tt user@example.com claude",
    sshConnection: {
      program: "ssh",
      options: [],
      target: "user@example.com",
    },
  };

  const spec = terminalSpawnSpecFromLeaf(leaf);

  assert.equal(spec.command, "ssh -tt user@example.com claude");
  assert.deepEqual(spec.sshConnection, {
    program: "ssh",
    options: [],
    target: "user@example.com",
    ttyMode: "force",
  });
  assert.deepEqual(spec.commandArgv, ["ssh", "-tt", "user@example.com", "claude"]);
  assert.equal(spec.cwd, undefined);
  assert.equal(isLocalTerminalLeaf(leaf), false);
});

test("terminal spawn spec keeps cwd for local leaves only", () => {
  const localLeaf: LeafNode = {
    type: "leaf",
    id: "local",
    ptyId: null,
    lastCwd: "/home/me/project",
  };
  const sshLeaf: LeafNode = {
    type: "leaf",
    id: "ssh",
    ptyId: null,
    command: "ssh me@example.com",
    lastCwd: "/home/me/project",
  };

  assert.equal(isLocalTerminalLeaf(localLeaf), true);
  assert.deepEqual(
    {
      cwd: terminalSpawnSpecFromLeaf(localLeaf).cwd,
      cwdSource: terminalSpawnSpecFromLeaf(localLeaf).cwdSource,
    },
    { cwd: "/home/me/project", cwdSource: "local" },
  );
  assert.equal(isLocalTerminalLeaf(sshLeaf), false);
  assert.equal(terminalSpawnSpecFromLeaf(sshLeaf).cwd, undefined);
  assert.equal(terminalSpawnSpecFromLeaf(sshLeaf).cwdSource, undefined);
});

test("terminal spawn spec prefers agent session cwd over local cwd", () => {
  const leaf: LeafNode = {
    type: "leaf",
    id: "agent",
    ptyId: null,
    command: "codex resume 11111111-2222-3333-4444-555555555555",
    lastCwd: "/home/me/shell",
    agentSession: {
      kind: "codex",
      sessionId: "11111111-2222-3333-4444-555555555555",
      cwd: "/home/me/codex-project",
      updatedAt: 10,
    },
  };

  const spec = terminalSpawnSpecFromLeaf(leaf);

  assert.equal(spec.cwd, "/home/me/codex-project");
  assert.equal(spec.cwdSource, "agent");
});

test("agent session reporting spawn spec is limited to local shell and direct agent commands", () => {
  assert.equal(isLocalAgentSessionReportingSpawnSpec({}, undefined), true);
  assert.equal(
    isLocalAgentSessionReportingSpawnSpec({ command: "codex resume abc" }, undefined),
    true,
  );
  assert.equal(
    isLocalAgentSessionReportingSpawnSpec({ command: "claude" }, undefined),
    true,
  );
  assert.equal(
    isLocalAgentSessionReportingSpawnSpec({ command: "npm test" }, undefined),
    false,
  );
  assert.equal(
    isLocalAgentSessionReportingSpawnSpec(
      {
        command: "ssh me@example.com",
        commandArgv: ["ssh", "me@example.com"],
        sshConnection: {
          program: "ssh",
          options: [],
          target: "me@example.com",
        },
      },
      undefined,
    ),
    false,
  );
  assert.equal(isLocalAgentSessionReportingSpawnSpec({}, "wmux-host"), false);
});

test("terminal session layout selectors only target terminal leaves", () => {
  const workspaces: Workspace[] = [
    {
      id: "ws",
      name: "Workspace",
      nameSource: "manual",
      focusedLeafId: "leaf-a",
      layout: {
        type: "split",
        id: "split",
        direction: "horizontal",
        ratio: 0.5,
        children: [
          {
            type: "browser",
            id: "browser-a",
            url: "https://example.com",
          },
          {
            type: "leaf",
            id: "leaf-a",
            ptyId: 11,
            cloneFromPtyId: 7,
            command: "ssh user@example.com codex",
            tmuxSession: "wmux-example",
            aiKind: "codex",
          },
        ],
      },
    },
  ];

  assert.equal(findTerminalLeaf(workspaces, "ws", "browser-a"), undefined);
  assert.equal(terminalLeafExists(workspaces, "ws", "browser-a"), false);
  assert.equal(terminalLeafExists(workspaces, "ws", "leaf-a"), true);
  assert.equal(findTerminalCloneFromPtyId(workspaces, "ws", "leaf-a"), 7);
  assert.equal(findTerminalTmuxSession(workspaces, "ws", "leaf-a"), "wmux-example");
  assert.equal(findTerminalAiKind(workspaces, "ws", "leaf-a"), "codex");
  assert.deepEqual(findTerminalSpawnSpec(workspaces, "ws", "missing"), {});
});
