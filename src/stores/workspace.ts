import { create } from "zustand";
import { useTmuxSessionsStore } from "./tmuxSessions";
import { getRuntimePlatform, type RuntimePlatform } from "../utils/runtimePlatform";
import {
  buildSshCommandWithRemoteCmdFromConnection,
  parseSshCommandLine,
  quotePosixShellArg,
  type SshConnection,
} from "../utils/sshConnection";

// Split tree types
export type SplitDirection = "horizontal" | "vertical";

// Known AI CLI tools that we surface as a per-pane toolbar. The list is closed so
// callers can switch on it; remote install detection (`check_remote_clis`) decides
// which ones are actually offered.
export type AiKind = "claude" | "codex" | "gemini" | "copilot";

export interface SplitNode {
  type: "split";
  id: string;
  direction: SplitDirection;
  ratio: number; // 0-1, position of the divider
  children: [LayoutNode, LayoutNode];
}

export interface LeafNode {
  type: "leaf";
  id: string;
  ptyId: number | null;
  cloneFromPtyId?: number; // PTY ID of the source pane when split
  sshCommand?: string; // SSH command to restore on session reload
  command?: string; // Direct command to run as PTY process (e.g., "ssh user@host")
  sshConnection?: SshConnection;
  sshRemoteCommand?: string;
  /**
   * When set, spawn via `spawn_pty_tmux_cc` using `command` as ssh_command and this
   * field as tmux session name. Enables tmux-CC persistence on the remote.
   */
  tmuxSession?: string;
  // AI CLI metadata: lets the UI render an "add another AI pane" toolbar on top of
  // any pane that was started as a known AI CLI. `aiSshTarget` is the parsed
  // user@host string and is what AI availability is keyed by.
  aiKind?: AiKind;
  aiSshTarget?: string;
}

export interface BrowserNode {
  type: "browser";
  id: string;
  url: string;
}

export interface MonitorNode {
  type: "monitor";
  id: string;
  sshTarget: string;
  sshCommand?: string;
  sshConnection?: SshConnection;
  monitorId: string;
}

export interface ClaudeSessionNode {
  type: "claudeSession";
  id: string;
  sshTarget: string;
  sshConnection?: SshConnection;
  project: string;
  sessionId: string;
  monitorId: string;
}

export type LayoutNode = SplitNode | LeafNode | BrowserNode | MonitorNode | ClaudeSessionNode;

export type LayoutMode =
  | "free"
  | "even-horizontal"
  | "even-vertical"
  | "main-vertical"
  | "main-horizontal"
  | "tiled";

export interface Workspace {
  id: string;
  name: string;
  nameSource: "auto" | "manual";
  layout: LayoutNode;
  focusedLeafId: string;
  zoomedLeafId?: string;
  layoutMode?: LayoutMode;
}

// Session save/restore types
interface SavedLeaf {
  type: "leaf";
  id: string;
  sshCommand?: string;
  command?: string;
  sshConnection?: SshConnection;
  sshRemoteCommand?: string;
  tmuxSession?: string;
  aiKind?: AiKind;
  aiSshTarget?: string;
}

interface SavedBrowser {
  type: "browser";
  id: string;
  url: string;
}

interface SavedSplit {
  type: "split";
  id: string;
  direction: SplitDirection;
  ratio: number;
  children: [SavedLayout, SavedLayout];
}

interface SavedMonitor {
  type: "monitor";
  id: string;
  sshTarget: string;
  sshCommand?: string;
  sshConnection?: SshConnection;
  monitorId: string;
}

interface SavedClaudeSession {
  type: "claudeSession";
  id: string;
  sshTarget: string;
  sshConnection?: SshConnection;
  project: string;
  sessionId: string;
  monitorId: string;
}

type SavedLayout = SavedLeaf | SavedBrowser | SavedSplit | SavedMonitor | SavedClaudeSession;

interface SavedWorkspace {
  id: string;
  name: string;
  nameSource?: "auto" | "manual";
  layout: SavedLayout;
  focusedLeafId: string;
}

interface SavedSession {
  schemaVersion?: number;
  sourcePlatform?: RuntimePlatform;
  workspaces: SavedWorkspace[];
  activeId: string | null;
}

interface WorkspaceState {
  workspaces: Workspace[];
  activeId: string | null;

  addWorkspace: (name?: string, command?: string, tmuxSession?: string, sshConnection?: SshConnection, sshRemoteCommand?: string) => string;
  removeWorkspace: (id: string) => void;
  setActive: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  setAutoWorkspaceName: (id: string, name: string) => void;
  setPtyId: (workspaceId: string, leafId: string, ptyId: number) => void;

  resetWorkspace: (id: string) => void;
  openBrowser: (workspaceId: string, leafId: string, url: string) => void;

  // Split operations
  splitLeaf: (workspaceId: string, leafId: string, direction: SplitDirection) => string;
  splitLeafWithCommand: (
    workspaceId: string,
    leafId: string,
    direction: SplitDirection,
    command: string,
    aiMeta?: { aiKind: AiKind; aiSshTarget?: string; sshConnection?: SshConnection; sshRemoteCommand?: string },
  ) => string;
  closeLeaf: (workspaceId: string, leafId: string) => void;
  setFocusedLeaf: (workspaceId: string, leafId: string) => void;
  setSplitRatio: (workspaceId: string, splitId: string, ratio: number) => void;
  toggleZoom: (workspaceId: string) => void;
  cycleLayout: (workspaceId: string) => void;
  breakPane: (workspaceId: string, leafId: string) => void;
  reorderWorkspaces: (fromIdx: number, toIdx: number) => void;

  setSshCommand: (workspaceId: string, leafId: string, cmd: string | undefined) => void;

  openMonitor: (workspaceId: string, leafId: string, sshTarget: string, sshCommand?: string, sshConnection?: SshConnection) => string;
  openClaudeSession: (workspaceId: string, leafId: string, sshTarget: string, project: string, sessionId: string, monitorId: string, sshConnection?: SshConnection) => string;

  // Session persistence
  saveSession: () => void;
  restoreSession: () => boolean;
}

let counter = 0;
const genId = () => `n-${Date.now()}-${counter++}`;
const SESSION_STORAGE_KEY = "wmux-session";
const SESSION_SCHEMA_VERSION = 2;
const SESSION_PLATFORMS: RuntimePlatform[] = ["linux", "windows", "macos", "unknown"];

const savedPlatform = (platform: unknown): RuntimePlatform =>
  SESSION_PLATFORMS.includes(platform as RuntimePlatform)
    ? (platform as RuntimePlatform)
    : "unknown";

const isSessionPlatformCompatible = (
  sourcePlatform: RuntimePlatform,
  currentPlatform: RuntimePlatform,
): boolean =>
  sourcePlatform === "unknown" ||
  currentPlatform === "unknown" ||
  sourcePlatform === currentPlatform;

const isDefaultWorkspaceName = (name: string | undefined): boolean =>
  !name || /^Shell \d+$/.test(name);

// Infer AI CLI metadata from a free-form ssh command stored in `leaf.command`.
// Used by `restoreSession` so leaves saved by a pre-aiKind build still get a
// toolbar and don't trigger a duplicate auto-split on first launch after upgrade.
const AI_KIND_PATTERN = /(?:^|['" /])(claude|codex|gemini|copilot)\b/;
const SSH_TARGET_PATTERN = /(\S+@\S+)/;
const inferAiMetaFromCommand = (
  command: string | undefined,
): { aiKind: AiKind; aiSshTarget: string } | undefined => {
  if (!command) return undefined;
  const km = command.match(AI_KIND_PATTERN);
  if (!km) return undefined;
  const tm = command.match(SSH_TARGET_PATTERN);
  if (!tm) return undefined;
  // Strip a trailing quote if the matched token is something like `"user@host"`.
  const target = tm[1].replace(/^["']|["']$/g, "");
  return { aiKind: km[1] as AiKind, aiSshTarget: target };
};

// Helper: find and replace a node in the tree
const replaceNode = (
  tree: LayoutNode,
  targetId: string,
  replacement: LayoutNode,
): LayoutNode => {
  if (tree.id === targetId) return replacement;
  if (tree.type === "split") {
    return {
      ...tree,
      children: [
        replaceNode(tree.children[0], targetId, replacement),
        replaceNode(tree.children[1], targetId, replacement),
      ] as [LayoutNode, LayoutNode],
    };
  }
  return tree;
};

// Helper: remove a leaf and return sibling (or null if root)
const removeLeaf = (
  tree: LayoutNode,
  leafId: string,
): LayoutNode | null => {
  if (tree.type === "leaf" || tree.type === "browser" || tree.type === "monitor" || tree.type === "claudeSession") {
    return tree.id === leafId ? null : tree;
  }
  const [left, right] = tree.children;
  if (left.id === leafId) return right;
  if (right.id === leafId) return left;

  const newLeft = removeLeaf(left, leafId);
  if (newLeft !== left) {
    return newLeft === null ? right : { ...tree, children: [newLeft, right] };
  }
  const newRight = removeLeaf(right, leafId);
  if (newRight !== right) {
    return newRight === null ? left : { ...tree, children: [left, newRight] };
  }
  return tree;
};

// Helper: collect all leaf IDs (terminal + browser + monitor)
export const collectLeafIds = (node: LayoutNode): string[] => {
  if (node.type === "leaf") return [node.id];
  if (node.type === "browser") return [node.id];
  if (node.type === "monitor") return [node.id];
  if (node.type === "claudeSession") return [node.id];
  return [
    ...collectLeafIds(node.children[0]),
    ...collectLeafIds(node.children[1]),
  ];
};

// True if any leaf in the layout carries a tmux persist session. Used to decide
// when the workspace's tmux session poller can be detached.
const hasTmuxLeaf = (node: LayoutNode): boolean => {
  if (node.type === "leaf") return !!node.tmuxSession;
  if (node.type === "split")
    return hasTmuxLeaf(node.children[0]) || hasTmuxLeaf(node.children[1]);
  return false;
};

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeId: null,

  addWorkspace: (name?: string, command?: string, tmuxSession?: string, sshConnection?: SshConnection, sshRemoteCommand?: string) => {
    const leafId = genId();
    const wsId = genId();
    const leaf: LeafNode = {
      type: "leaf",
      id: leafId,
      ptyId: null,
      command: command ?? undefined,
      sshConnection: sshConnection ?? undefined,
      sshRemoteCommand: sshRemoteCommand ?? undefined,
      tmuxSession: tmuxSession ?? undefined,
    };
    const ws: Workspace = {
      id: wsId,
      name: name ?? `Shell ${get().workspaces.length + 1}`,
      nameSource: isDefaultWorkspaceName(name) ? "auto" : "manual",
      layout: leaf,
      focusedLeafId: leafId,
    };
    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeId: wsId,
    }));
    return wsId;
  },

  resetWorkspace: (id: string) => {
    const newLeafId = genId();
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id
          ? {
              ...w,
              name: "Shell 1",
              nameSource: "auto",
              layout: { type: "leaf" as const, id: newLeafId, ptyId: null },
              focusedLeafId: newLeafId,
            }
          : w,
      ),
    }));
    // The reset layout has no tmux pane; stop the session poller if one was running.
    if (useTmuxSessionsStore.getState()._attach[id]) {
      useTmuxSessionsStore.getState().detach(id);
    }
  },

  openBrowser: (workspaceId: string, leafId: string, url: string) => {
    const browserId = genId();
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const splitNode: SplitNode = {
          type: "split",
          id: genId(),
          direction: "horizontal",
          ratio: 0.5,
          children: [
            preserveLeaf(w.layout, leafId),
            { type: "browser", id: browserId, url },
          ],
        };
        return { ...w, layout: replaceNode(w.layout, leafId, splitNode) };
      }),
    }));
  },

  openMonitor: (workspaceId: string, leafId: string, sshTarget: string, sshCommand?: string, sshConnection?: SshConnection) => {
    const monitorNodeId = genId();
    const monitorId = `mon-${Date.now()}`;
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const splitNode: SplitNode = {
          type: "split",
          id: genId(),
          direction: "vertical",
          ratio: 0.7,
          children: [
            preserveLeaf(w.layout, leafId),
            { type: "monitor", id: monitorNodeId, sshTarget, sshCommand, sshConnection, monitorId },
          ],
        };
        return { ...w, layout: replaceNode(w.layout, leafId, splitNode) };
      }),
    }));
    return monitorId;
  },

  openClaudeSession: (workspaceId: string, leafId: string, sshTarget: string, project: string, sessionId: string, monitorId: string, sshConnection?: SshConnection) => {
    const claudeNodeId = genId();
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const splitNode: SplitNode = {
          type: "split",
          id: genId(),
          direction: "horizontal",
          ratio: 0.5,
          children: [
            preserveLeaf(w.layout, leafId),
            { type: "claudeSession", id: claudeNodeId, sshTarget, sshConnection, project, sessionId, monitorId },
          ],
        };
        return { ...w, layout: replaceNode(w.layout, leafId, splitNode) };
      }),
    }));
    return claudeNodeId;
  },

  removeWorkspace: (id: string) => {
    useTmuxSessionsStore.getState().detach(id);
    set((s) => {
      const filtered = s.workspaces.filter((w) => w.id !== id);
      const newActive =
        s.activeId === id
          ? filtered[filtered.length - 1]?.id ?? null
          : s.activeId;
      return { workspaces: filtered, activeId: newActive };
    });
  },

  setActive: (id: string) => set({ activeId: id }),

  renameWorkspace: (id: string, name: string) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, name, nameSource: "manual" } : w,
      ),
    }));
  },

  setAutoWorkspaceName: (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id && w.nameSource !== "manual" && w.name !== trimmed
          ? { ...w, name: trimmed, nameSource: "auto" }
          : w,
      ),
    }));
  },

  setPtyId: (workspaceId: string, leafId: string, ptyId: number) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const updatePty = (node: LayoutNode): LayoutNode => {
          if (node.type === "leaf" && node.id === leafId) {
            return { ...node, ptyId };
          }
          if (node.type === "split") {
            return {
              ...node,
              children: [
                updatePty(node.children[0]),
                updatePty(node.children[1]),
              ] as [LayoutNode, LayoutNode],
            };
          }
          return node;
        };
        return { ...w, layout: updatePty(w.layout) };
      }),
    }));
  },

  splitLeaf: (workspaceId: string, leafId: string, direction: SplitDirection) => {
    const newLeafId = genId();
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const parent = findLeaf(w.layout, leafId);
        const inheritedCmd =
          parent?.command && /^ssh\b/i.test(parent.command) ? parent.command : undefined;
        const inheritedSshConnection = inheritedCmd ? parent?.sshConnection : undefined;
        const inheritedSshRemoteCommand = inheritedCmd ? parent?.sshRemoteCommand : undefined;
        // Inherit tmux-persist mode with a unique session name per pane so each leaf
        // reconnects independently. Strip any prior `-n-<ts>-<cnt>` marker (from a
        // previous split) so names stay bounded across repeated splits; the `n-`
        // sentinel disambiguates from host names that may legitimately end in
        // `-<digits>-<digits>` (e.g. `wmux-host-10-20`).
        const parentBase = parent?.tmuxSession?.replace(/-n-\d+-\d+$/, "");
        const inheritedTmuxSession = parentBase
          ? `${parentBase}-${newLeafId}`
          : undefined;
        const splitNode: SplitNode = {
          type: "split",
          id: genId(),
          direction,
          ratio: 0.5,
          children: [
            preserveLeaf(w.layout, leafId),
            {
              type: "leaf",
              id: newLeafId,
              ptyId: null,
              cloneFromPtyId: parent?.ptyId ?? undefined,
              command: inheritedCmd,
              sshConnection: inheritedSshConnection,
              sshRemoteCommand: inheritedSshRemoteCommand,
              tmuxSession: inheritedTmuxSession,
            },
          ],
        };
        return {
          ...w,
          layout: replaceNode(w.layout, leafId, splitNode),
          focusedLeafId: newLeafId,
          zoomedLeafId: undefined,
          layoutMode: "free",
        };
      }),
    }));
    return newLeafId;
  },

  splitLeafWithCommand: (workspaceId, leafId, direction, command, aiMeta) => {
    // Intentionally does NOT inherit `tmuxSession` from the parent — callers pass a
    // full ssh command that already embeds a remote command (e.g. claude auto-split
    // uses `ssh -t user@host "bash -lc 'claude ...'"`). The tmux wrapper in
    // `spawn_tmux_cc` appends `-t tmux new-session ...` to the ssh command, which
    // would collide with the embedded remote command. The new pane is therefore a
    // raw ssh invocation by design.
    const newLeafId = genId();
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const splitNode: SplitNode = {
          type: "split",
          id: genId(),
          direction,
          ratio: 0.5,
          children: [
            preserveLeaf(w.layout, leafId),
            {
              type: "leaf",
              id: newLeafId,
              ptyId: null,
              command,
              sshConnection: aiMeta?.sshConnection,
              sshRemoteCommand: aiMeta?.sshRemoteCommand,
              aiKind: aiMeta?.aiKind,
              aiSshTarget: aiMeta?.aiSshTarget,
            },
          ],
        };
        return {
          ...w,
          layout: replaceNode(w.layout, leafId, splitNode),
          zoomedLeafId: undefined,
          layoutMode: "free",
        };
      }),
    }));
    return newLeafId;
  },

  closeLeaf: (workspaceId: string, leafId: string) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const newLayout = removeLeaf(w.layout, leafId);
        if (!newLayout) return w; // Don't remove last leaf
        const leaves = collectLeafIds(newLayout);
        const newFocus = leaves.includes(w.focusedLeafId)
          ? w.focusedLeafId
          : leaves[0];
        return {
          ...w,
          layout: newLayout,
          focusedLeafId: newFocus,
          zoomedLeafId: w.zoomedLeafId === leafId ? undefined : w.zoomedLeafId,
          layoutMode: "free",
        };
      }),
    }));
    // If closing this leaf left no tmux pane behind, stop the session poller so
    // it doesn't keep SSH-polling a workspace that no longer has a tmux session.
    const tmux = useTmuxSessionsStore.getState();
    if (tmux._attach[workspaceId]) {
      const w = get().workspaces.find((x) => x.id === workspaceId);
      if (w && !hasTmuxLeaf(w.layout)) tmux.detach(workspaceId);
    }
  },

  setFocusedLeaf: (workspaceId: string, leafId: string) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, focusedLeafId: leafId } : w,
      ),
    }));
  },

  setSshCommand: (workspaceId: string, leafId: string, cmd: string | undefined) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const update = (node: LayoutNode): LayoutNode => {
          if (node.type === "leaf" && node.id === leafId) return { ...node, sshCommand: cmd };
          if (node.type === "split") {
            return { ...node, children: [update(node.children[0]), update(node.children[1])] as [LayoutNode, LayoutNode] };
          }
          return node;
        };
        return { ...w, layout: update(w.layout) };
      }),
    }));
  },

  saveSession: () => {
    const state = get();
    const stripPty = (node: LayoutNode): SavedLayout => {
      if (node.type === "leaf") return { type: "leaf", id: node.id, sshCommand: node.sshCommand, command: node.command, sshConnection: node.sshConnection, sshRemoteCommand: node.sshRemoteCommand, tmuxSession: node.tmuxSession, aiKind: node.aiKind, aiSshTarget: node.aiSshTarget };
      if (node.type === "browser") return { type: "browser", id: node.id, url: node.url };
      if (node.type === "monitor") return { type: "monitor", id: node.id, sshTarget: node.sshTarget, sshCommand: node.sshCommand, sshConnection: node.sshConnection, monitorId: node.monitorId };
      if (node.type === "claudeSession") return { type: "claudeSession", id: node.id, sshTarget: node.sshTarget, sshConnection: node.sshConnection, project: node.project, sessionId: node.sessionId, monitorId: node.monitorId };
      return {
        type: "split",
        id: node.id,
        direction: node.direction,
        ratio: node.ratio,
        children: [stripPty(node.children[0]), stripPty(node.children[1])],
      };
    };

    const session: SavedSession = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sourcePlatform: getRuntimePlatform(),
      workspaces: state.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        nameSource: w.nameSource,
        layout: stripPty(w.layout),
        focusedLeafId: w.focusedLeafId,
      })),
      activeId: state.activeId,
    };

    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {}
  },

  restoreSession: () => {
    try {
      const raw = localStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return false;

      const session: SavedSession = JSON.parse(raw);
      if (!session.workspaces || session.workspaces.length === 0) return false;
      const restorePlatformBoundCommands = isSessionPlatformCompatible(
        savedPlatform(session.sourcePlatform),
        getRuntimePlatform(),
      );

      const restoreLayout = (node: SavedLayout): LayoutNode => {
        if (node.type === "leaf") {
          const command = restorePlatformBoundCommands ? node.command : undefined;
          const sshCommand = restorePlatformBoundCommands ? node.sshCommand : undefined;
          const tmuxSession = restorePlatformBoundCommands ? node.tmuxSession : undefined;
          const parsedSsh = parseSshCommandLine(command ?? sshCommand);
          const sshConnection = restorePlatformBoundCommands ? node.sshConnection ?? parsedSsh?.connection : undefined;
          const sshRemoteCommand = restorePlatformBoundCommands ? node.sshRemoteCommand ?? parsedSsh?.remoteCommand : undefined;
          // Migration: leaves saved by builds before aiKind existed have only the
          // command string. Try to infer kind+target so the toolbar still works
          // and `hasAiPane` checks aren't fooled into adding a duplicate.
          const inferred = node.aiKind ? undefined : inferAiMetaFromCommand(command);
          return {
            type: "leaf",
            id: node.id,
            ptyId: null,
            sshCommand,
            command,
            sshConnection,
            sshRemoteCommand,
            tmuxSession,
            aiKind: restorePlatformBoundCommands ? node.aiKind ?? inferred?.aiKind : undefined,
            aiSshTarget: restorePlatformBoundCommands ? node.aiSshTarget ?? inferred?.aiSshTarget : undefined,
          };
        }
        if (node.type === "browser") return { type: "browser", id: node.id, url: node.url };
        // Monitor nodes are now sidebar-based; restore as plain leaf
        if (node.type === "monitor") return { type: "leaf", id: node.id, ptyId: null };
        // ClaudeSession nodes need active SSH connection; restore as SSH terminal leaf
        if (node.type === "claudeSession") {
          const fallback = parseSshCommandLine(`ssh ${node.sshTarget}`);
          const sshConnection = restorePlatformBoundCommands ? node.sshConnection ?? fallback?.connection : undefined;
          const remote = `claude --resume ${quotePosixShellArg(node.sessionId)}`;
          return {
            type: "leaf",
            id: node.id,
            ptyId: null,
            command: restorePlatformBoundCommands && sshConnection
              ? buildSshCommandWithRemoteCmdFromConnection(sshConnection, remote, true)
              : undefined,
            sshConnection,
            sshRemoteCommand: restorePlatformBoundCommands ? remote : undefined,
          };
        }
        return {
          type: "split",
          id: node.id,
          direction: node.direction,
          ratio: node.ratio,
          children: [restoreLayout(node.children[0]), restoreLayout(node.children[1])],
        };
      };

      const workspaces: Workspace[] = session.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        nameSource: w.nameSource ?? (isDefaultWorkspaceName(w.name) ? "auto" : "manual"),
        layout: restoreLayout(w.layout),
        focusedLeafId: w.focusedLeafId,
      }));

      set({ workspaces, activeId: session.activeId });
      return true;
    } catch {
      return false;
    }
  },

  setSplitRatio: (workspaceId: string, splitId: string, ratio: number) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const updateRatio = (node: LayoutNode): LayoutNode => {
          if (node.type === "split" && node.id === splitId) {
            return { ...node, ratio: Math.max(0.1, Math.min(0.9, ratio)) };
          }
          if (node.type === "split") {
            return {
              ...node,
              children: [
                updateRatio(node.children[0]),
                updateRatio(node.children[1]),
              ] as [LayoutNode, LayoutNode],
            };
          }
          return node;
        };
        return { ...w, layout: updateRatio(w.layout), layoutMode: "free" };
      }),
    }));
  },

  toggleZoom: (workspaceId: string) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        if (w.zoomedLeafId) return { ...w, zoomedLeafId: undefined };
        const leaves = collectLeafIds(w.layout);
        if (leaves.length < 2) return w;
        return { ...w, zoomedLeafId: w.focusedLeafId };
      }),
    }));
  },

  cycleLayout: (workspaceId: string) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const leaves = collectOrderedLeafNodes(w.layout);
        if (leaves.length < 2) return w;
        const order: LayoutMode[] = [
          "even-horizontal",
          "even-vertical",
          "main-vertical",
          "main-horizontal",
          "tiled",
        ];
        const effective: LayoutMode | "free" =
          w.layoutMode && order.includes(w.layoutMode)
            ? w.layoutMode
            : detectLayoutShape(w.layout);
        const curIdx = order.indexOf(effective as LayoutMode);
        const nextMode = order[(curIdx + 1) % order.length];
        const newLayout = buildLayout(leaves, nextMode);
        return { ...w, layout: newLayout, layoutMode: nextMode, zoomedLeafId: undefined };
      }),
    }));
  },

  reorderWorkspaces: (fromIdx: number, toIdx: number) => {
    set((s) => {
      if (
        fromIdx < 0 ||
        toIdx < 0 ||
        fromIdx >= s.workspaces.length ||
        toIdx >= s.workspaces.length ||
        fromIdx === toIdx
      ) {
        return {};
      }
      const next = s.workspaces.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return { workspaces: next };
    });
  },

  breakPane: (workspaceId: string, leafId: string) => {
    const newWsId = genId();
    set((s) => {
      const ws = s.workspaces.find((w) => w.id === workspaceId);
      if (!ws) return {};
      const leaves = collectLeafIds(ws.layout);
      if (leaves.length < 2) return {};
      const detached = findAnyNode(ws.layout, leafId);
      if (!detached) return {};
      const remaining = removeLeaf(ws.layout, leafId);
      if (!remaining) return {};
      const remainingIds = collectLeafIds(remaining);
      const newWs: Workspace = {
        id: newWsId,
        name: `Shell ${s.workspaces.length + 1}`,
        nameSource: "auto",
        layout: detached,
        focusedLeafId: leafId,
      };
      return {
        workspaces: s.workspaces
          .map((w) =>
            w.id === workspaceId
              ? {
                  ...w,
                  layout: remaining,
                  focusedLeafId: remainingIds.includes(w.focusedLeafId)
                    ? w.focusedLeafId
                    : remainingIds[0],
                  zoomedLeafId: undefined,
                }
              : w,
          )
          .concat([newWs]),
        activeId: newWsId,
      };
    });
  },
}));

// Helper: walk tree and return any node by id (leaf / browser / monitor / claude / split)
const findAnyNode = (node: LayoutNode, id: string): LayoutNode | null => {
  if (node.id === id) return node;
  if (node.type === "split") {
    return findAnyNode(node.children[0], id) ?? findAnyNode(node.children[1], id);
  }
  return null;
};

// Helper: collect all leaf-like nodes (not splits) in tree order, preserving identity
const collectOrderedLeafNodes = (node: LayoutNode): LayoutNode[] => {
  if (node.type === "split") {
    return [
      ...collectOrderedLeafNodes(node.children[0]),
      ...collectOrderedLeafNodes(node.children[1]),
    ];
  }
  return [node];
};

// Helper: rebuild a layout tree from a flat list of leaf nodes using a target layout mode.
const buildLayout = (leaves: LayoutNode[], mode: LayoutMode): LayoutNode => {
  if (leaves.length === 1) return leaves[0];
  if (mode === "even-horizontal") return buildChain(leaves, "horizontal");
  if (mode === "even-vertical") return buildChain(leaves, "vertical");
  if (mode === "main-vertical") {
    // Main pane on the left, rest stacked vertically on the right
    const [main, ...rest] = leaves;
    return {
      type: "split",
      id: genId(),
      direction: "horizontal",
      ratio: 0.5,
      children: [main, buildChain(rest, "vertical")],
    };
  }
  if (mode === "main-horizontal") {
    // Main pane on the top, rest split horizontally below
    const [main, ...rest] = leaves;
    return {
      type: "split",
      id: genId(),
      direction: "vertical",
      ratio: 0.5,
      children: [main, buildChain(rest, "horizontal")],
    };
  }
  if (mode === "tiled") return buildTiled(leaves);
  return buildChain(leaves, "horizontal");
};

const buildChain = (leaves: LayoutNode[], direction: SplitDirection): LayoutNode => {
  if (leaves.length === 1) return leaves[0];
  const mid = Math.floor(leaves.length / 2);
  const left = buildChain(leaves.slice(0, mid), direction);
  const right = buildChain(leaves.slice(mid), direction);
  return {
    type: "split",
    id: genId(),
    direction,
    ratio: mid / leaves.length,
    children: [left, right],
  };
};

// Classify the current tree shape: if every split uses the same direction, return the corresponding
// even-* mode; otherwise "free". Used when layoutMode is unset so the first cycle press does
// something visible.
const detectLayoutShape = (node: LayoutNode): LayoutMode | "free" => {
  if (node.type !== "split") return "even-horizontal";
  const allDir = (n: LayoutNode, dir: SplitDirection): boolean => {
    if (n.type !== "split") return true;
    return n.direction === dir && allDir(n.children[0], dir) && allDir(n.children[1], dir);
  };
  if (allDir(node, "horizontal")) return "even-horizontal";
  if (allDir(node, "vertical")) return "even-vertical";
  return "free";
};

const buildTiled = (leaves: LayoutNode[]): LayoutNode => {
  if (leaves.length === 1) return leaves[0];
  const n = leaves.length;
  const rows = Math.ceil(Math.sqrt(n));
  const cols = Math.ceil(n / rows);
  const rowNodes: LayoutNode[] = [];
  for (let r = 0; r < rows; r++) {
    const slice = leaves.slice(r * cols, (r + 1) * cols);
    if (slice.length === 0) continue;
    rowNodes.push(buildChain(slice, "horizontal"));
  }
  return buildChain(rowNodes, "vertical");
};

// Helper: get a leaf with all its fields preserved (command, sshCommand, etc.)
const preserveLeaf = (tree: LayoutNode, id: string): LeafNode => {
  const existing = findLeaf(tree, id);
  if (existing) return { ...existing };
  return { type: "leaf", id, ptyId: null };
};

// Helper: find a leaf node by id
const findLeaf = (node: LayoutNode, id: string): LeafNode | null => {
  if (node.type === "leaf") return node.id === id ? node : null;
  if (node.type === "browser" || node.type === "monitor" || node.type === "claudeSession") return null;
  return findLeaf(node.children[0], id) ?? findLeaf(node.children[1], id);
};

// Helper: find leaf by ptyId across all workspaces
export const findLeafByPtyId = (
  workspaces: Workspace[],
  ptyId: number,
): { workspaceId: string; leafId: string; leafCount: number; tmuxSession?: string } | null => {
  for (const ws of workspaces) {
    const leaves = collectLeafIds(ws.layout);
    for (const leafId of leaves) {
      const leaf = findLeaf(ws.layout, leafId);
      if (leaf && leaf.ptyId === ptyId) {
        return { workspaceId: ws.id, leafId, leafCount: leaves.length, tmuxSession: leaf.tmuxSession };
      }
    }
  }
  return null;
};
