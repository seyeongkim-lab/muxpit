import test from "node:test";
import assert from "node:assert/strict";

import { useSettingsStore } from "../src/stores/settings.ts";
import { useWorkspaceStore, type LayoutNode, type LeafNode, type Workspace } from "../src/stores/workspace.ts";

class MemoryStorage {
  private items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }

  clear(): void {
    this.items.clear();
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", {
  value: storage,
  configurable: true,
});

const findLeaf = (node: LayoutNode, id: string): LeafNode | undefined => {
  if (node.type === "leaf") return node.id === id ? node : undefined;
  if (node.type === "split") return findLeaf(node.children[0], id) ?? findLeaf(node.children[1], id);
  return undefined;
};

const resetStores = () => {
  storage.clear();
  useSettingsStore.setState({
    enableExperimentalCwdRestore: false,
    enableExperimentalAgentSessionRestore: false,
    enableExperimentalAgentDangerousResume: false,
  });
  useWorkspaceStore.setState({ workspaces: [], activeId: null });
};

const workspaceWithCwd = (): Workspace => ({
  id: "ws",
  name: "Workspace",
  nameSource: "manual",
  focusedLeafId: "local",
  layout: {
    type: "split",
    id: "split",
    direction: "horizontal",
    ratio: 0.5,
    children: [
      {
        type: "leaf",
        id: "local",
        ptyId: null,
        lastCwd: "/home/me/project",
      },
      {
        type: "leaf",
        id: "ssh",
        ptyId: null,
        command: "ssh me@example.com",
        lastCwd: "/home/me/remote-shadow",
      },
    ],
  },
});

const workspaceWithAgentSession = (): Workspace => ({
  id: "ws",
  name: "Workspace",
  nameSource: "manual",
  focusedLeafId: "agent",
  layout: {
    type: "leaf",
    id: "agent",
    ptyId: null,
    command: "codex",
    agentSession: {
      kind: "codex",
      sessionId: "11111111-2222-3333-4444-555555555555",
      cwd: "/home/me/codex-project",
      event: "Stop",
      updatedAt: 10,
    },
  },
});

const workspaceWithAgentAndShell = (): Workspace => ({
  id: "ws",
  name: "Workspace",
  nameSource: "manual",
  focusedLeafId: "agent",
  layout: {
    type: "split",
    id: "split",
    direction: "horizontal",
    ratio: 0.5,
    children: [
      workspaceWithAgentSession().layout,
      {
        type: "leaf",
        id: "shell",
        ptyId: null,
      },
    ],
  },
});

test("workspace session stores and restores local cwd only when experimental feature is enabled", () => {
  resetStores();
  useSettingsStore.setState({ enableExperimentalCwdRestore: true });
  useWorkspaceStore.setState({ workspaces: [workspaceWithCwd()], activeId: "ws" });

  useWorkspaceStore.getState().saveSession();

  const saved = JSON.parse(storage.getItem("wmux-session") ?? "{}");
  assert.equal(saved.workspaces[0].layout.children[0].lastCwd, "/home/me/project");
  assert.equal(saved.workspaces[0].layout.children[1].lastCwd, undefined);

  useWorkspaceStore.setState({ workspaces: [], activeId: null });
  assert.equal(useWorkspaceStore.getState().restoreSession(), true);

  const restored = useWorkspaceStore.getState().workspaces[0];
  assert.equal(findLeaf(restored.layout, "local")?.lastCwd, "/home/me/project");
  assert.equal(findLeaf(restored.layout, "ssh")?.lastCwd, undefined);
});

test("workspace session omits and ignores cwd when experimental feature is disabled", () => {
  resetStores();
  useWorkspaceStore.setState({ workspaces: [workspaceWithCwd()], activeId: "ws" });

  useWorkspaceStore.getState().saveSession();
  const saved = JSON.parse(storage.getItem("wmux-session") ?? "{}");
  assert.equal(saved.workspaces[0].layout.children[0].lastCwd, undefined);

  saved.workspaces[0].layout.children[0].lastCwd = "/home/me/project";
  storage.setItem("wmux-session", JSON.stringify(saved));
  useWorkspaceStore.setState({ workspaces: [], activeId: null });

  assert.equal(useWorkspaceStore.getState().restoreSession(), true);
  const restored = useWorkspaceStore.getState().workspaces[0];
  assert.equal(findLeaf(restored.layout, "local")?.lastCwd, undefined);
});

test("workspace session preserves explicit launch cwd without enabling cwd restore", () => {
  resetStores();
  const workspace: Workspace = {
    id: "ws",
    name: "Workspace",
    nameSource: "manual",
    focusedLeafId: "agent",
    layout: {
      type: "leaf",
      id: "agent",
      ptyId: null,
      command: "codex",
      launchCwd: "/home/me/project",
    },
  };
  useWorkspaceStore.setState({ workspaces: [workspace], activeId: "ws" });

  useWorkspaceStore.getState().saveSession();
  const saved = JSON.parse(storage.getItem("wmux-session") ?? "{}");
  assert.equal(saved.workspaces[0].layout.launchCwd, "/home/me/project");

  useWorkspaceStore.setState({ workspaces: [], activeId: null });
  assert.equal(useWorkspaceStore.getState().restoreSession(), true);
  assert.equal(
    findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "agent")?.launchCwd,
    "/home/me/project",
  );
});

test("setLeafCwd only updates local cwd when the value changes", () => {
  resetStores();
  useSettingsStore.setState({ enableExperimentalCwdRestore: true });
  useWorkspaceStore.setState({ workspaces: [workspaceWithCwd()], activeId: "ws" });

  const beforeSameValue = useWorkspaceStore.getState().workspaces[0];
  useWorkspaceStore.getState().setLeafCwd("ws", "local", "/home/me/project");
  assert.equal(useWorkspaceStore.getState().workspaces[0], beforeSameValue);

  const cwdWithTrailingSpace = "/home/me/project ";
  useWorkspaceStore.getState().setLeafCwd("ws", "local", cwdWithTrailingSpace);
  const updated = useWorkspaceStore.getState().workspaces[0];
  assert.notEqual(updated, beforeSameValue);
  assert.equal(findLeaf(updated.layout, "local")?.lastCwd, cwdWithTrailingSpace);

  useWorkspaceStore.getState().setLeafCwd("ws", "ssh", "/home/me/remote");
  assert.equal(findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "ssh")?.lastCwd, "/home/me/remote-shadow");
});

test("clearSavedCwd removes cwd from live workspaces and stored sessions immediately", () => {
  resetStores();
  useSettingsStore.setState({ enableExperimentalCwdRestore: true });
  useWorkspaceStore.setState({ workspaces: [workspaceWithCwd()], activeId: "ws" });
  useWorkspaceStore.getState().saveSession();

  const platformSession = {
    schemaVersion: 2,
    sourcePlatform: "unknown",
    activeId: "ws",
    workspaces: [
      {
        id: "ws",
        name: "Workspace",
        nameSource: "manual",
        focusedLeafId: "local",
        layout: {
          type: "leaf",
          id: "local",
          lastCwd: "/tmp/platform-cwd",
        },
      },
    ],
  };
  storage.setItem("wmux-session:unknown", JSON.stringify(platformSession));

  useSettingsStore.setState({ enableExperimentalCwdRestore: false });
  useWorkspaceStore.getState().clearSavedCwd();

  const live = useWorkspaceStore.getState().workspaces[0];
  assert.equal(findLeaf(live.layout, "local")?.lastCwd, undefined);
  assert.equal(findLeaf(live.layout, "ssh")?.lastCwd, undefined);

  const saved = JSON.parse(storage.getItem("wmux-session") ?? "{}");
  assert.equal(saved.workspaces[0].layout.children[0].lastCwd, undefined);

  const savedPlatform = JSON.parse(storage.getItem("wmux-session:unknown") ?? "{}");
  assert.equal(savedPlatform.workspaces[0].layout.lastCwd, undefined);
});

test("workspace session stores and restores Codex agent sessions when experimental feature is enabled", () => {
  resetStores();
  useSettingsStore.setState({ enableExperimentalAgentSessionRestore: true });
  useWorkspaceStore.setState({ workspaces: [workspaceWithAgentSession()], activeId: "ws" });

  useWorkspaceStore.getState().saveSession();

  const saved = JSON.parse(storage.getItem("wmux-session") ?? "{}");
  assert.equal(saved.workspaces[0].layout.agentSession.sessionId, "11111111-2222-3333-4444-555555555555");

  useWorkspaceStore.setState({ workspaces: [], activeId: null });
  assert.equal(useWorkspaceStore.getState().restoreSession(), true);

  const restored = useWorkspaceStore.getState().workspaces[0];
  const leaf = findLeaf(restored.layout, "agent");
  assert.equal(leaf?.command, "codex");
  assert.equal(leaf?.agentSession?.cwd, "/home/me/codex-project");
  assert.equal(leaf?.aiKind, undefined);
});

test("workspace session can restore agent sessions with dangerous resume flags", () => {
  resetStores();
  useSettingsStore.setState({
    enableExperimentalAgentSessionRestore: true,
    enableExperimentalAgentDangerousResume: true,
  });
  useWorkspaceStore.setState({ workspaces: [workspaceWithAgentSession()], activeId: "ws" });
  useWorkspaceStore.getState().saveSession();

  useWorkspaceStore.setState({ workspaces: [], activeId: null });
  assert.equal(useWorkspaceStore.getState().restoreSession(), true);

  const leaf = findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "agent");
  assert.equal(leaf?.command, "codex");
  assert.equal(leaf?.agentSession?.sessionId, "11111111-2222-3333-4444-555555555555");
});

test("workspace session omits and ignores agent sessions when experimental feature is disabled", () => {
  resetStores();
  useWorkspaceStore.setState({ workspaces: [workspaceWithAgentSession()], activeId: "ws" });

  useWorkspaceStore.getState().saveSession();
  const saved = JSON.parse(storage.getItem("wmux-session") ?? "{}");
  assert.equal(saved.workspaces[0].layout.agentSession, undefined);

  saved.workspaces[0].layout.agentSession = (workspaceWithAgentSession().layout as LeafNode).agentSession;
  storage.setItem("wmux-session", JSON.stringify(saved));
  useWorkspaceStore.setState({ workspaces: [], activeId: null });

  assert.equal(useWorkspaceStore.getState().restoreSession(), true);
  const leaf = findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "agent");
  assert.equal(leaf?.command, "codex");
  assert.equal(leaf?.agentSession, undefined);
});

test("setLeafAgentSession only updates local leaves while feature is enabled", () => {
  resetStores();
  useSettingsStore.setState({ enableExperimentalAgentSessionRestore: true });
  useWorkspaceStore.setState({ workspaces: [workspaceWithAgentAndShell()], activeId: "ws" });

  useWorkspaceStore.getState().setLeafAgentSession("ws", "agent", {
    kind: "codex",
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    cwd: "/home/me/codex-project",
    updatedAt: 20,
  });
  useWorkspaceStore.getState().setLeafAgentSession("ws", "shell", {
    kind: "codex",
    sessionId: "11111111-2222-3333-4444-555555555555",
    cwd: "/home/me/remote-codex",
    updatedAt: 30,
  });

  const layout = useWorkspaceStore.getState().workspaces[0].layout;
  assert.equal(findLeaf(layout, "agent")?.agentSession?.kind, "codex");
  assert.equal(findLeaf(layout, "shell")?.agentSession?.kind, "codex");
  assert.equal(findLeaf(layout, "shell")?.agentSession?.baseCommand, undefined);
});

test("setLeafAgentSession ignores SSH leaves and conflicting direct agent commands", () => {
  resetStores();
  useSettingsStore.setState({ enableExperimentalAgentSessionRestore: true });
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: "ws",
        name: "Workspace",
        nameSource: "manual",
        focusedLeafId: "agent",
        layout: {
          type: "split",
          id: "split",
          direction: "horizontal",
          ratio: 0.5,
          children: [
            {
              type: "leaf",
              id: "claude",
              ptyId: null,
              command: "claude",
            },
            {
              type: "leaf",
              id: "ssh",
              ptyId: null,
              command: "ssh me@example.com",
            },
          ],
        },
      },
    ],
    activeId: "ws",
  });

  useWorkspaceStore.getState().setLeafAgentSession("ws", "claude", {
    kind: "codex",
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    updatedAt: 20,
  });
  useWorkspaceStore.getState().setLeafAgentSession("ws", "ssh", {
    kind: "codex",
    sessionId: "11111111-2222-3333-4444-555555555555",
    updatedAt: 30,
  });

  const layout = useWorkspaceStore.getState().workspaces[0].layout;
  assert.equal(findLeaf(layout, "claude")?.agentSession, undefined);
  assert.equal(findLeaf(layout, "ssh")?.agentSession, undefined);
});

test("setLeafAgentSession ignores wrapped and prompt-bearing agent commands", () => {
  resetStores();
  useSettingsStore.setState({ enableExperimentalAgentSessionRestore: true });
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: "ws",
        name: "Workspace",
        nameSource: "manual",
        focusedLeafId: "wrapped",
        layout: {
          type: "split",
          id: "split",
          direction: "horizontal",
          ratio: 0.5,
          children: [
            {
              type: "leaf",
              id: "wrapped",
              ptyId: null,
              command: "bash -lc codex",
            },
            {
              type: "leaf",
              id: "prompt",
              ptyId: null,
              command: "codex 'fix tests'",
            },
          ],
        },
      },
    ],
    activeId: "ws",
  });

  useWorkspaceStore.getState().setLeafAgentSession("ws", "wrapped", {
    kind: "codex",
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    event: "SessionStart",
    updatedAt: 20,
  });
  useWorkspaceStore.getState().setLeafAgentSession("ws", "prompt", {
    kind: "codex",
    sessionId: "11111111-2222-3333-4444-555555555555",
    event: "SessionStart",
    updatedAt: 30,
  });

  const layout = useWorkspaceStore.getState().workspaces[0].layout;
  assert.equal(findLeaf(layout, "wrapped")?.agentSession, undefined);
  assert.equal(findLeaf(layout, "prompt")?.agentSession, undefined);
});

test("setLeafAgentSession preserves cwd when a later hook omits it", () => {
  resetStores();
  useSettingsStore.setState({ enableExperimentalAgentSessionRestore: true });
  useWorkspaceStore.setState({ workspaces: [workspaceWithAgentSession()], activeId: "ws" });

  useWorkspaceStore.getState().setLeafAgentSession("ws", "agent", {
    kind: "codex",
    sessionId: "11111111-2222-3333-4444-555555555555",
    event: "UserPromptSubmit",
    updatedAt: 20,
  });

  const leaf = findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "agent");
  assert.equal(leaf?.agentSession?.cwd, "/home/me/codex-project");
  assert.equal(leaf?.agentSession?.event, "UserPromptSubmit");
});

test("setLeafAgentSession rejects option-shaped session ids", () => {
  resetStores();
  useSettingsStore.setState({ enableExperimentalAgentSessionRestore: true });
  useWorkspaceStore.setState({ workspaces: [workspaceWithAgentSession()], activeId: "ws" });

  useWorkspaceStore.getState().setLeafAgentSession("ws", "agent", {
    kind: "codex",
    sessionId: "--dangerously-bypass-approvals-and-sandbox",
    updatedAt: 20,
  });

  const leaf = findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "agent");
  assert.equal(leaf?.agentSession?.sessionId, "11111111-2222-3333-4444-555555555555");
});

test("setLeafAgentSession ignores stale non-start events for a different session", () => {
  resetStores();
  useSettingsStore.setState({ enableExperimentalAgentSessionRestore: true });
  useWorkspaceStore.setState({ workspaces: [workspaceWithAgentAndShell()], activeId: "ws" });

  useWorkspaceStore.getState().setLeafAgentSession("ws", "shell", {
    kind: "codex",
    sessionId: "22222222-3333-4444-5555-666666666666",
    event: "SessionStart",
    updatedAt: 20,
  });
  useWorkspaceStore.getState().setLeafAgentSession("ws", "shell", {
    kind: "codex",
    sessionId: "11111111-2222-3333-4444-555555555555",
    event: "Stop",
    updatedAt: 30,
  });

  const shell = findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "shell");
  assert.equal(shell?.agentSession?.sessionId, "22222222-3333-4444-5555-666666666666");

  useWorkspaceStore.getState().setLeafAgentSession("ws", "shell", {
    kind: "codex",
    sessionId: "33333333-4444-5555-6666-777777777777",
    event: "SessionStart",
    updatedAt: 40,
  });

  const switched = findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "shell");
  assert.equal(switched?.agentSession?.sessionId, "33333333-4444-5555-6666-777777777777");
});

test("clearLeafAgentSession only removes the matching live agent session", () => {
  resetStores();
  useSettingsStore.setState({ enableExperimentalAgentSessionRestore: true });
  useWorkspaceStore.setState({ workspaces: [workspaceWithAgentAndShell()], activeId: "ws" });

  useWorkspaceStore.getState().setLeafAgentSession("ws", "shell", {
    kind: "codex",
    sessionId: "22222222-3333-4444-5555-666666666666",
    event: "SessionStart",
    updatedAt: 20,
  });

  useWorkspaceStore.getState().clearLeafAgentSession("ws", "shell", {
    kind: "codex",
    sessionId: "11111111-2222-3333-4444-555555555555",
  });
  const stale = findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "shell");
  assert.equal(stale?.agentSession?.sessionId, "22222222-3333-4444-5555-666666666666");

  useWorkspaceStore.getState().clearLeafAgentSession("ws", "shell", {
    kind: "codex",
    sessionId: "22222222-3333-4444-5555-666666666666",
  });
  const cleared = findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "shell");
  assert.equal(cleared?.agentSession, undefined);
  assert.equal(cleared?.command, undefined);
});

test("workspace session stores base command instead of generated resume command", () => {
  resetStores();
  useSettingsStore.setState({
    enableExperimentalAgentSessionRestore: true,
    enableExperimentalAgentDangerousResume: true,
  });
  useWorkspaceStore.setState({ workspaces: [workspaceWithAgentSession()], activeId: "ws" });
  useWorkspaceStore.getState().saveSession();
  useWorkspaceStore.setState({ workspaces: [], activeId: null });
  assert.equal(useWorkspaceStore.getState().restoreSession(), true);

  useWorkspaceStore.getState().saveSession();
  const saved = JSON.parse(storage.getItem("wmux-session") ?? "{}");
  assert.equal(saved.workspaces[0].layout.command, "codex");
  assert.equal(saved.workspaces[0].layout.agentSession.sessionId, "11111111-2222-3333-4444-555555555555");
  assert.equal(saved.workspaces[0].layout.agentSession.baseCommand, "codex");
});

test("workspace session restores shell-origin agent sessions without changing fallback command", () => {
  resetStores();
  useSettingsStore.setState({
    enableExperimentalAgentSessionRestore: true,
    enableExperimentalAgentDangerousResume: true,
  });
  useWorkspaceStore.setState({ workspaces: [workspaceWithAgentAndShell()], activeId: "ws" });

  useWorkspaceStore.getState().setLeafAgentSession("ws", "shell", {
    kind: "codex",
    sessionId: "22222222-3333-4444-5555-666666666666",
    cwd: "/home/me/shell-codex",
    event: "Stop",
    updatedAt: 30,
  });
  useWorkspaceStore.getState().saveSession();

  const saved = JSON.parse(storage.getItem("wmux-session") ?? "{}");
  const savedShell = saved.workspaces[0].layout.children[1];
  assert.equal(savedShell.command, undefined);
  assert.equal(savedShell.agentSession.sessionId, "22222222-3333-4444-5555-666666666666");
  assert.equal(savedShell.agentSession.baseCommand, undefined);

  useWorkspaceStore.setState({ workspaces: [], activeId: null });
  assert.equal(useWorkspaceStore.getState().restoreSession(), true);

  const restoredShell = findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "shell");
  assert.equal(restoredShell?.command, undefined);
  assert.equal(restoredShell?.agentSession?.cwd, "/home/me/shell-codex");
  assert.equal(restoredShell?.agentSession?.baseCommand, undefined);

  useWorkspaceStore.getState().saveSession();
  const savedAgain = JSON.parse(storage.getItem("wmux-session") ?? "{}");
  const savedAgainShell = savedAgain.workspaces[0].layout.children[1];
  assert.equal(savedAgainShell.command, undefined);
  assert.equal(savedAgainShell.agentSession.sessionId, "22222222-3333-4444-5555-666666666666");
});

test("workspace session preserves direct agent base command flags and paths", () => {
  resetStores();
  useSettingsStore.setState({ enableExperimentalAgentSessionRestore: true });
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: "ws",
        name: "Workspace",
        nameSource: "manual",
        focusedLeafId: "agent",
        layout: {
          type: "leaf",
          id: "agent",
          ptyId: null,
          command: "/opt/bin/codex --profile work",
        },
      },
    ],
    activeId: "ws",
  });

  useWorkspaceStore.getState().setLeafAgentSession("ws", "agent", {
    kind: "codex",
    sessionId: "33333333-4444-5555-6666-777777777777",
    updatedAt: 10,
  });
  useWorkspaceStore.getState().saveSession();

  const saved = JSON.parse(storage.getItem("wmux-session") ?? "{}");
  assert.equal(saved.workspaces[0].layout.agentSession.baseCommand, "/opt/bin/codex --profile work");

  useWorkspaceStore.setState({ workspaces: [], activeId: null });
  assert.equal(useWorkspaceStore.getState().restoreSession(), true);

  const restored = findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "agent");
  assert.equal(restored?.command, "/opt/bin/codex --profile work");
  assert.equal(restored?.agentSession?.baseCommand, "/opt/bin/codex --profile work");
});

test("workspace session strips dangerous flags from stored direct agent base commands", () => {
  resetStores();
  useSettingsStore.setState({ enableExperimentalAgentSessionRestore: true });
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: "ws",
        name: "Workspace",
        nameSource: "manual",
        focusedLeafId: "agent",
        layout: {
          type: "leaf",
          id: "agent",
          ptyId: null,
          command: "codex --dangerously-bypass-approvals-and-sandbox --profile work",
        },
      },
    ],
    activeId: "ws",
  });

  useWorkspaceStore.getState().setLeafAgentSession("ws", "agent", {
    kind: "codex",
    sessionId: "33333333-4444-5555-6666-777777777777",
    updatedAt: 10,
  });
  useWorkspaceStore.getState().saveSession();

  const saved = JSON.parse(storage.getItem("wmux-session") ?? "{}");
  assert.equal(saved.workspaces[0].layout.command, "codex --profile work");
  assert.equal(saved.workspaces[0].layout.agentSession.baseCommand, "codex --profile work");
  assert.deepEqual(saved.workspaces[0].layout.agentSession.baseCommandArgv, [
    "codex",
    "--profile",
    "work",
  ]);

  useWorkspaceStore.setState({ workspaces: [], activeId: null });
  assert.equal(useWorkspaceStore.getState().restoreSession(), true);

  const restored = findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "agent");
  assert.equal(restored?.command, "codex --profile work");
  assert.equal(restored?.agentSession?.baseCommand, "codex --profile work");
});

test("workspace session does not persist agent sessions for non-restorable command shapes", () => {
  resetStores();
  useSettingsStore.setState({ enableExperimentalAgentSessionRestore: true });
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: "ws",
        name: "Workspace",
        nameSource: "manual",
        focusedLeafId: "wrapped",
        layout: {
          type: "leaf",
          id: "wrapped",
          ptyId: null,
          command: "env CODEX_HOME=/tmp/codex codex",
          agentSession: {
            kind: "codex",
            sessionId: "11111111-2222-3333-4444-555555555555",
            updatedAt: 10,
          },
        },
      },
    ],
    activeId: "ws",
  });

  useWorkspaceStore.getState().saveSession();

  const saved = JSON.parse(storage.getItem("wmux-session") ?? "{}");
  assert.equal(saved.workspaces[0].layout.command, "env CODEX_HOME=/tmp/codex codex");
  assert.equal(saved.workspaces[0].layout.agentSession, undefined);
});

test("clearSavedAgentSessions removes agent sessions from live workspaces and stored sessions immediately", () => {
  resetStores();
  useSettingsStore.setState({
    enableExperimentalAgentSessionRestore: true,
    enableExperimentalAgentDangerousResume: true,
  });
  useWorkspaceStore.setState({ workspaces: [workspaceWithAgentSession()], activeId: "ws" });
  useWorkspaceStore.getState().saveSession();
  storage.setItem("wmux-session:unknown", storage.getItem("wmux-session") ?? "{}");
  useWorkspaceStore.setState({ workspaces: [], activeId: null });
  assert.equal(useWorkspaceStore.getState().restoreSession(), true);
  useWorkspaceStore.getState().saveSession();

  useSettingsStore.setState({ enableExperimentalAgentSessionRestore: false });
  useWorkspaceStore.getState().clearSavedAgentSessions();

  const live = useWorkspaceStore.getState().workspaces[0];
  const liveLeaf = findLeaf(live.layout, "agent");
  assert.equal(liveLeaf?.agentSession, undefined);
  assert.equal(liveLeaf?.command, "codex");
  assert.equal(liveLeaf?.aiKind, undefined);

  const saved = JSON.parse(storage.getItem("wmux-session") ?? "{}");
  assert.equal(saved.workspaces[0].layout.agentSession, undefined);
  assert.equal(saved.workspaces[0].layout.command, "codex");
  assert.equal(saved.workspaces[0].layout.aiKind, undefined);

  const savedPlatform = JSON.parse(storage.getItem("wmux-session:unknown") ?? "{}");
  assert.equal(savedPlatform.workspaces[0].layout.agentSession, undefined);
  assert.equal(savedPlatform.workspaces[0].layout.command, "codex");
});

test("clearSavedAgentSessions returns shell-origin restored agents to the default shell", () => {
  resetStores();
  useSettingsStore.setState({
    enableExperimentalAgentSessionRestore: true,
    enableExperimentalAgentDangerousResume: true,
  });
  useWorkspaceStore.setState({ workspaces: [workspaceWithAgentAndShell()], activeId: "ws" });
  useWorkspaceStore.getState().setLeafAgentSession("ws", "shell", {
    kind: "codex",
    sessionId: "22222222-3333-4444-5555-666666666666",
    updatedAt: 30,
  });
  useWorkspaceStore.getState().saveSession();
  useWorkspaceStore.setState({ workspaces: [], activeId: null });
  assert.equal(useWorkspaceStore.getState().restoreSession(), true);

  useSettingsStore.setState({ enableExperimentalAgentSessionRestore: false });
  useWorkspaceStore.getState().clearSavedAgentSessions();

  const liveShell = findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "shell");
  assert.equal(liveShell?.agentSession, undefined);
  assert.equal(liveShell?.command, undefined);
});

test("workspace restore sanitizes generated resume commands when agent restore is disabled", () => {
  resetStores();
  const saved = {
    schemaVersion: 2,
    sourcePlatform: "unknown",
    activeId: "ws",
    workspaces: [
      {
        id: "ws",
        name: "Workspace",
        nameSource: "manual",
        focusedLeafId: "agent",
        layout: {
          type: "leaf",
          id: "agent",
          command: "codex resume --dangerously-bypass-approvals-and-sandbox 11111111-2222-3333-4444-555555555555",
          agentSession: (workspaceWithAgentSession().layout as LeafNode).agentSession,
        },
      },
    ],
  };
  storage.setItem("wmux-session", JSON.stringify(saved));

  assert.equal(useWorkspaceStore.getState().restoreSession(), true);
  const leaf = findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "agent");
  assert.equal(leaf?.command, "codex");
  assert.equal(leaf?.agentSession, undefined);
});

test("workspace restore preserves command-only generated resume commands", () => {
  resetStores();
  const saved = {
    schemaVersion: 2,
    sourcePlatform: "unknown",
    activeId: "ws",
    workspaces: [
      {
        id: "ws",
        name: "Workspace",
        nameSource: "manual",
        focusedLeafId: "agent",
        layout: {
          type: "leaf",
          id: "agent",
          command: "codex resume --dangerously-bypass-approvals-and-sandbox 11111111-2222-3333-4444-555555555555",
        },
      },
    ],
  };
  storage.setItem("wmux-session", JSON.stringify(saved));

  assert.equal(useWorkspaceStore.getState().restoreSession(), true);
  const leaf = findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "agent");
  assert.equal(
    leaf?.command,
    "codex resume --dangerously-bypass-approvals-and-sandbox 11111111-2222-3333-4444-555555555555",
  );
  assert.equal(leaf?.agentSession, undefined);
});

test("workspace restore preserves explicit command-only resume forms without session ids", () => {
  resetStores();
  const saved = {
    schemaVersion: 2,
    sourcePlatform: "unknown",
    activeId: "ws",
    workspaces: [
      {
        id: "ws",
        name: "Workspace",
        nameSource: "manual",
        focusedLeafId: "agent",
        layout: {
          type: "leaf",
          id: "agent",
          command: "codex resume --last",
        },
      },
    ],
  };
  storage.setItem("wmux-session", JSON.stringify(saved));

  assert.equal(useWorkspaceStore.getState().restoreSession(), true);
  const leaf = findLeaf(useWorkspaceStore.getState().workspaces[0].layout, "agent");
  assert.equal(leaf?.command, "codex resume --last");
  assert.equal(leaf?.agentSession, undefined);
});
