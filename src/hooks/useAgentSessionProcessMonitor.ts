import { useEffect, useRef } from "react";
import { useSettingsStore } from "../stores/settings";
import { useWorkspaceStore, type LayoutNode, type LeafNode } from "../stores/workspace";
import { updateAgentProcessMonitorEntry, type AgentProcessMonitorEntry } from "../utils/agentProcessMonitor";
import type { PtyBackend } from "../utils/ptyBackend";
import { getPtyBackend } from "../utils/runtimePtyBackend";
import { parseSshCommandLine } from "../utils/sshConnection";

interface MonitoredLeaf {
  workspaceId: string;
  leaf: LeafNode;
}

const collectLeaves = (node: LayoutNode): LeafNode[] => {
  if (node.type === "leaf") return [node];
  if (node.type === "split") {
    return [...collectLeaves(node.children[0]), ...collectLeaves(node.children[1])];
  }
  return [];
};

const isLocalAgentLeaf = (leaf: LeafNode): boolean => {
  if (leaf.tmuxSession || leaf.sshCommand || leaf.sshConnection) return false;
  return !parseSshCommandLine(leaf.command);
};

const monitorKey = (workspaceId: string, leafId: string): string =>
  `${workspaceId}:${leafId}`;

export const useAgentSessionProcessMonitor = (
  intervalMs = 2000,
  backend: Pick<PtyBackend, "hasAgentProcess"> = getPtyBackend(),
) => {
  const entriesRef = useRef(new Map<string, AgentProcessMonitorEntry>());

  useEffect(() => {
    let active = true;
    let polling = false;

    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        if (!useSettingsStore.getState().enableExperimentalAgentSessionRestore) {
          entriesRef.current.clear();
          return;
        }

        const monitored: MonitoredLeaf[] = [];
        for (const workspace of useWorkspaceStore.getState().workspaces) {
          for (const leaf of collectLeaves(workspace.layout)) {
            if (
              leaf.ptyId &&
              leaf.agentSession?.kind === "codex" &&
              isLocalAgentLeaf(leaf)
            ) {
              monitored.push({ workspaceId: workspace.id, leaf });
            }
          }
        }

        const liveKeys = new Set(
          monitored.map(({ workspaceId, leaf }) => monitorKey(workspaceId, leaf.id)),
        );
        for (const key of entriesRef.current.keys()) {
          if (!liveKeys.has(key)) entriesRef.current.delete(key);
        }

        await Promise.all(
          monitored.map(async ({ workspaceId, leaf }) => {
            const agentSession = leaf.agentSession;
            if (!agentSession || agentSession.kind !== "codex" || !leaf.ptyId) return;
            let present: boolean;
            try {
              present = await backend.hasAgentProcess(leaf.ptyId, "codex");
            } catch {
              return;
            }
            if (!active) return;

            const key = monitorKey(workspaceId, leaf.id);
            const update = updateAgentProcessMonitorEntry(
              entriesRef.current.get(key),
              { kind: "codex", sessionId: agentSession.sessionId },
              present,
              2,
            );
            entriesRef.current.set(key, update.entry);
            if (update.shouldClear) {
              useWorkspaceStore.getState().clearLeafAgentSession(workspaceId, leaf.id, {
                kind: "codex",
                sessionId: agentSession.sessionId,
              });
            }
          }),
        );
      } finally {
        polling = false;
      }
    };

    const initial = setTimeout(poll, intervalMs);
    const timer = setInterval(poll, intervalMs);
    return () => {
      active = false;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [backend, intervalMs]);
};
