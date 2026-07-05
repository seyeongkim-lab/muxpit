import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore, collectLeafIds, type LayoutNode, type LeafNode, type Workspace } from "../stores/workspace";
import { useSettingsStore } from "../stores/settings";
import type { AiTerminalStatusKind } from "../utils/aiTerminalStatus";

const findLeafInLayout = (node: LayoutNode, id: string): LayoutNode | null => {
  if ((node.type === "leaf" || node.type === "browser" || node.type === "monitor" || node.type === "claudeSession") && node.id === id) return node;
  if (node.type === "split") return findLeafInLayout(node.children[0], id) ?? findLeafInLayout(node.children[1], id);
  return null;
};

export interface WorkspaceInfo {
  cwd: string;
  gitBranch: string | null;
  gitDirty: boolean;
  ports: number[];
  processName: string | null;
  command: string | null;
  agent: string | null;
  memoryBytes: number;
  cpuPercent: number;
  descendantCount: number;
  terminalTitle: string | null;
  aiStatusLabel: string | null;
  aiStatusKind: AiTerminalStatusKind | null;
  aiStatusUpdatedAt: number | null;
}

interface SessionMetadata {
  cwd: string;
  git_branch: string | null;
  git_dirty: boolean;
  ports: number[];
  process_name: string | null;
  command: string | null;
  agent: string | null;
  memory_bytes: number;
  cpu_percent: number;
  descendant_count: number;
}

const emptyInfo = (prev?: WorkspaceInfo): WorkspaceInfo => ({
  cwd: prev?.cwd ?? "",
  gitBranch: null,
  gitDirty: false,
  ports: [],
  processName: null,
  command: null,
  agent: null,
  memoryBytes: 0,
  cpuPercent: 0,
  descendantCount: 0,
  terminalTitle: prev?.terminalTitle ?? null,
  aiStatusLabel: prev?.aiStatusLabel ?? null,
  aiStatusKind: prev?.aiStatusKind ?? null,
  aiStatusUpdatedAt: prev?.aiStatusUpdatedAt ?? null,
});

const sshInfo = (prev?: WorkspaceInfo): WorkspaceInfo => ({
  ...emptyInfo(),
  cwd: prev?.agent === "ssh" ? prev.cwd : "",
  terminalTitle: prev?.agent === "ssh" ? prev.terminalTitle : null,
  agent: "ssh",
  aiStatusLabel: null,
  aiStatusKind: null,
  aiStatusUpdatedAt: null,
});

interface WorkspaceInfoState {
  info: Record<string, WorkspaceInfo>; // keyed by workspace id
  setInfo: (wsId: string, info: WorkspaceInfo) => void;
  patchInfo: (wsId: string, patch: Partial<WorkspaceInfo>) => void;
}

export const useWorkspaceInfoStore = create<WorkspaceInfoState>((set) => ({
  info: {},
  setInfo: (wsId, info) =>
    set((s) => ({ info: { ...s.info, [wsId]: info } })),
  patchInfo: (wsId, patch) =>
    set((s) => ({
      info: {
        ...s.info,
        [wsId]: { ...emptyInfo(s.info[wsId]), ...s.info[wsId], ...patch },
      },
    })),
}));

const findFirstTerminalLeaf = (node: LayoutNode): LeafNode | null => {
  if (node.type === "leaf") return node;
  if (node.type === "split") return findFirstTerminalLeaf(node.children[0]) ?? findFirstTerminalLeaf(node.children[1]);
  return null;
};

const collectTerminalLeaves = (node: LayoutNode): LeafNode[] => {
  if (node.type === "leaf") return [node];
  if (node.type === "split") {
    return [...collectTerminalLeaves(node.children[0]), ...collectTerminalLeaves(node.children[1])];
  }
  return [];
};

const findRepresentativeLeaf = (workspace: Workspace): LeafNode | null => {
  const focused = findLeafInLayout(workspace.layout, workspace.focusedLeafId);
  if (focused?.type === "leaf") return focused;
  return findFirstTerminalLeaf(workspace.layout);
};

const isSshLeaf = (leaf: LeafNode): boolean => {
  if (leaf.tmuxSession || leaf.sshCommand) return true;
  return /^\s*ssh\b/i.test(leaf.command ?? "");
};

const compactPath = (path: string): string =>
  path
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~");

const isUsefulTerminalTitle = (title: string | null): title is string => {
  if (!title) return false;
  const trimmed = title.trim();
  if (trimmed.length < 3) return false;
  const lower = trimmed.toLowerCase();
  return !["claude", "claude code", "terminal", "shell", "bash", "zsh"].includes(lower);
};

const buildAutoWorkspaceName = (info: WorkspaceInfo): string | null => {
  if (info.agent === "claude" && isUsefulTerminalTitle(info.terminalTitle)) {
    return info.terminalTitle.trim();
  }
  if ((info.agent === "codex" || info.agent === "claude") && info.cwd) {
    return compactPath(info.cwd);
  }
  return null;
};

// Polls workspace metadata every N seconds
export const useWorkspaceInfoPoller = (intervalMs = 3000) => {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setInfo = useWorkspaceInfoStore((s) => s.setInfo);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      // Read the live list each tick so the effect doesn't need to re-subscribe
      // on every workspace mutation (which would reset the interval).
      const wsList = useWorkspaceStore.getState().workspaces;
      const cwdRestoreEnabled = useSettingsStore.getState().enableExperimentalCwdRestore;
      const pollLeafCwd = async (workspaceId: string, leaf: LeafNode) => {
        if (!cwdRestoreEnabled || !leaf.ptyId || isSshLeaf(leaf)) return;
        try {
          const metadata = await invoke<SessionMetadata>("get_session_metadata", {
            id: leaf.ptyId,
            cwd: leaf.lastCwd ?? null,
          });
          if (active) {
            useWorkspaceStore.getState().setLeafCwd(workspaceId, leaf.id, metadata.cwd);
          }
        } catch {
          // Silently ignore polling errors
        }
      };

      // Poll all workspaces in parallel
      await Promise.all(
        wsList.map(async (ws) => {
          if (!active) return;

          const state = useWorkspaceStore.getState();
          const workspace = state.workspaces.find((w) => w.id === ws.id);
          if (!workspace) return;
          const leaf = findRepresentativeLeaf(workspace);
          if (!leaf?.ptyId) {
            await Promise.all(
              collectTerminalLeaves(workspace.layout).map((candidate) =>
                pollLeafCwd(ws.id, candidate),
              ),
            );
            return;
          }

          if (isSshLeaf(leaf)) {
            const prev = useWorkspaceInfoStore.getState().info[ws.id];
            setInfo(ws.id, sshInfo(prev));
            await Promise.all(
              collectTerminalLeaves(workspace.layout)
                .filter((candidate) => candidate.id !== leaf.id)
                .map((candidate) => pollLeafCwd(ws.id, candidate)),
            );
            return;
          }

          try {
            const prev = useWorkspaceInfoStore.getState().info[ws.id];
            const metadata = await invoke<SessionMetadata>("get_session_metadata", {
              id: leaf.ptyId,
              cwd: prev?.cwd || null,
            });

            const nextInfo: WorkspaceInfo = {
              cwd: metadata.cwd,
              gitBranch: metadata.git_branch,
              gitDirty: metadata.git_dirty,
              ports: metadata.ports,
              processName: metadata.process_name,
              command: metadata.command,
              agent: leaf.aiKind ?? metadata.agent,
              memoryBytes: metadata.memory_bytes,
              cpuPercent: metadata.cpu_percent,
              descendantCount: metadata.descendant_count,
              terminalTitle: prev?.terminalTitle ?? null,
              aiStatusLabel: prev?.aiStatusLabel ?? null,
              aiStatusKind: prev?.aiStatusKind ?? null,
              aiStatusUpdatedAt: prev?.aiStatusUpdatedAt ?? null,
            };
            setInfo(ws.id, nextInfo);
            if (cwdRestoreEnabled) {
              useWorkspaceStore.getState().setLeafCwd(ws.id, leaf.id, metadata.cwd);
              await Promise.all(
                collectTerminalLeaves(workspace.layout)
                  .filter((candidate) => candidate.id !== leaf.id)
                  .map((candidate) => pollLeafCwd(ws.id, candidate)),
              );
            }

            const autoName = buildAutoWorkspaceName(nextInfo);
            if (autoName) {
              useWorkspaceStore.getState().setAutoWorkspaceName(ws.id, autoName);
            }
          } catch {
            // Silently ignore polling errors
          }
        }),
      );
    };

    poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [workspaces.length, setInfo, intervalMs]);
};

// Separate slow poller for SSH context caching (for session restore)
export const useSshContextPoller = (intervalMs = 30000) => {
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      const state = useWorkspaceStore.getState();
      for (const ws of state.workspaces) {
        if (!active) return;
        const allLeaves = collectLeafIds(ws.layout);
        for (const lid of allLeaves) {
          if (!active) return;
          const leaf = findLeafInLayout(ws.layout, lid);
          if (leaf && leaf.type === "leaf" && leaf.ptyId) {
            try {
              const ctx = await invoke<{ ssh_command: string | null }>(
                "get_shell_ctx",
                { id: leaf.ptyId },
              );
              useWorkspaceStore.getState().setSshCommand(ws.id, lid, ctx.ssh_command ?? undefined);
            } catch {}
          }
        }
      }
    };

    const timer = setInterval(poll, intervalMs);
    // First poll after 5 seconds (let app settle)
    const initial = setTimeout(poll, 5000);
    return () => {
      active = false;
      clearInterval(timer);
      clearTimeout(initial);
    };
  }, [workspaces.length, intervalMs]); // Only re-run when workspace count changes
};
