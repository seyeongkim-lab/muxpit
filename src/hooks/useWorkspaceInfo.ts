import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore, collectLeafIds, type LayoutNode } from "../stores/workspace";

const findLeafInLayout = (node: LayoutNode, id: string): LayoutNode | null => {
  if ((node.type === "leaf" || node.type === "browser" || node.type === "monitor" || node.type === "claudeSession") && node.id === id) return node;
  if (node.type === "split") return findLeafInLayout(node.children[0], id) ?? findLeafInLayout(node.children[1], id);
  return null;
};

interface WorkspaceInfo {
  cwd: string;
  gitBranch: string | null;
  gitDirty: boolean;
  ports: number[];
}

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
        [wsId]: { ...s.info[wsId], ...patch },
      },
    })),
}));

// Polls workspace metadata every N seconds
export const useWorkspaceInfoPoller = (intervalMs = 3000) => {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setInfo = useWorkspaceInfoStore((s) => s.setInfo);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      // Poll all workspaces in parallel
      await Promise.all(
        workspaces.map(async (ws) => {
          if (!active) return;

          const findPtyId = (): number | null => {
            const state = useWorkspaceStore.getState();
            const w = state.workspaces.find((w) => w.id === ws.id);
            if (!w) return null;

            const findInNode = (node: typeof w.layout): number | null => {
              if (node.type === "leaf") return node.ptyId;
              if (node.type === "browser" || node.type === "monitor" || node.type === "claudeSession") return null;
              return findInNode(node.children[0]) ?? findInNode(node.children[1]);
            };
            return findInNode(w.layout);
          };

          const ptyId = findPtyId();
          if (ptyId === null) return;

          try {
            const cwd = "C:\\Users\\one";

            // Run git info and port detection in parallel
            const [info, pid] = await Promise.all([
              invoke<{
                cwd: string;
                git_branch: string | null;
                git_dirty: boolean;
                ports: number[];
              }>("get_workspace_info", { cwd }),
              invoke<number | null>("get_pty_pid", { id: ptyId }),
            ]);

            let ports: number[] = [];
            if (pid) {
              ports = await invoke<number[]>("get_ports", { pid });
            }

            setInfo(ws.id, {
              cwd: info.cwd,
              gitBranch: info.git_branch,
              gitDirty: info.git_dirty,
              ports,
            });
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
  }, [workspaces, setInfo, intervalMs]);
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
