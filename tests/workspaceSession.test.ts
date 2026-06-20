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
      transcriptPath: "/home/me/.codex/sessions/rollout.jsonl",
      event: "Stop",
      updatedAt: 10,
    },
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
  assert.equal(leaf?.command, "codex resume 11111111-2222-3333-4444-555555555555");
  assert.equal(leaf?.agentSession?.cwd, "/home/me/codex-project");
  assert.equal(leaf?.aiKind, "codex");
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
  assert.equal(
    leaf?.command,
    "codex resume --dangerously-bypass-approvals-and-sandbox 11111111-2222-3333-4444-555555555555",
  );
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
  useWorkspaceStore.setState({ workspaces: [workspaceWithCwd()], activeId: "ws" });

  useWorkspaceStore.getState().setLeafAgentSession("ws", "local", {
    kind: "claude",
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    cwd: "/home/me/claude-project",
    updatedAt: 20,
  });
  useWorkspaceStore.getState().setLeafAgentSession("ws", "ssh", {
    kind: "codex",
    sessionId: "11111111-2222-3333-4444-555555555555",
    cwd: "/home/me/remote-codex",
    updatedAt: 30,
  });

  const layout = useWorkspaceStore.getState().workspaces[0].layout;
  assert.equal(findLeaf(layout, "local")?.agentSession?.kind, "claude");
  assert.equal(findLeaf(layout, "ssh")?.agentSession, undefined);
});

test("clearSavedAgentSessions removes agent sessions from live workspaces and stored sessions immediately", () => {
  resetStores();
  useSettingsStore.setState({ enableExperimentalAgentSessionRestore: true });
  useWorkspaceStore.setState({ workspaces: [workspaceWithAgentSession()], activeId: "ws" });
  useWorkspaceStore.getState().saveSession();

  useSettingsStore.setState({ enableExperimentalAgentSessionRestore: false });
  useWorkspaceStore.getState().clearSavedAgentSessions();

  const live = useWorkspaceStore.getState().workspaces[0];
  assert.equal(findLeaf(live.layout, "agent")?.agentSession, undefined);

  const saved = JSON.parse(storage.getItem("wmux-session") ?? "{}");
  assert.equal(saved.workspaces[0].layout.agentSession, undefined);
});
