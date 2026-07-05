import type { WorkspaceInfo } from "../hooks/useWorkspaceInfo.ts";
import type { AttachInfo, TmuxSession } from "../stores/tmuxSessions.ts";
import type { LeafNode, LayoutNode, Workspace } from "../stores/workspace.ts";
import { detectAiAgentName, type AiTerminalStatusKind } from "./aiTerminalStatus.ts";
import { parseSshCommandLine } from "./sshConnection.ts";

export interface WorkspaceTabView {
  title: string;
  detail: string | null;
  paneCount: number;
  statusKind?: AiTerminalStatusKind | null;
}

const SHELL_NAMES = new Set([
  "bash",
  "cmd",
  "fish",
  "nu",
  "pwsh",
  "powershell",
  "sh",
  "shell",
  "terminal",
  "tmux",
  "zsh",
]);

const compactPath = (path: string): string =>
  path
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~");

const pathBaseName = (path: string | null | undefined): string | null => {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? compactPath(trimmed);
};

const isWindowsLocalPath = (path: string | null | undefined): boolean => {
  const trimmed = path?.trim();
  return !!trimmed && (/^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed));
};

const usefulTitle = (title: string | null | undefined): string | null => {
  const trimmed = title?.trim();
  if (!trimmed || trimmed.length < 3) return null;
  const lower = trimmed.toLowerCase();
  if (SHELL_NAMES.has(lower)) return null;
  return trimmed;
};

const usefulProcess = (processName: string | null | undefined): string | null => {
  const trimmed = processName?.trim();
  if (!trimmed) return null;
  const base = trimmed.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  if (SHELL_NAMES.has(base)) return null;
  return trimmed;
};

const usefulAiStatus = (label: string | null | undefined): string | null => {
  const trimmed = label?.trim();
  if (!trimmed || trimmed.length < 2) return null;
  return trimmed;
};

const collectLeafViews = (node: LayoutNode): LeafNode[] => {
  if (node.type === "leaf") return [node];
  if (node.type === "split") return [...collectLeafViews(node.children[0]), ...collectLeafViews(node.children[1])];
  return [];
};

const findFocusedLeaf = (node: LayoutNode, focusedLeafId: string): LeafNode | null => {
  if (node.type === "leaf") return node.id === focusedLeafId ? node : null;
  if (node.type === "split") return findFocusedLeaf(node.children[0], focusedLeafId) ?? findFocusedLeaf(node.children[1], focusedLeafId);
  return null;
};

const sshTargetForLeaf = (leaf: LeafNode | null): string | null => {
  if (!leaf) return null;
  if (leaf.sshConnection?.target) return leaf.sshConnection.target;
  const parsed = parseSshCommandLine(leaf.sshCommand ?? leaf.command);
  return parsed?.connection.target ?? leaf.aiSshTarget ?? null;
};

const sshCwdDetail = (path: string | null | undefined): string | null =>
  isWindowsLocalPath(path) ? null : pathBaseName(path);

const tmuxSessionName = (
  attach: AttachInfo | undefined,
  sessions: TmuxSession[] | undefined,
): string | null => {
  if (!attach) return null;
  const active = attach.activeSession;
  const session = sessions?.find((candidate) => candidate.id === active || candidate.name === active);
  const name = session?.name ?? active;
  if (!name || name === attach.wrapperSession) return null;
  return name.replace(/^\$/, "tmux ");
};

export const buildWorkspaceTabView = (
  workspace: Workspace,
  info?: WorkspaceInfo,
  attach?: AttachInfo,
  tmuxSessions?: TmuxSession[],
): WorkspaceTabView => {
  const leaves = collectLeafViews(workspace.layout);
  const paneCount = leaves.length;
  const focusedLeaf = findFocusedLeaf(workspace.layout, workspace.focusedLeafId) ?? leaves[0] ?? null;
  const cwdBase = pathBaseName(info?.cwd || focusedLeaf?.lastCwd);
  const agent = detectAiAgentName(focusedLeaf?.aiKind, info?.agent, info?.processName, info?.command);
  if (agent) {
    const aiStatus = usefulAiStatus(info?.aiStatusLabel);
    if (aiStatus) {
      return {
        title: `${agent}: ${aiStatus}`,
        detail: cwdBase ?? usefulProcess(info?.processName),
        paneCount,
        statusKind: info?.aiStatusKind ?? null,
      };
    }

    const aiTitle = usefulTitle(info?.terminalTitle);
    if (aiTitle) {
      return {
        title: aiTitle,
        detail: cwdBase,
        paneCount,
        statusKind: info?.aiStatusKind ?? null,
      };
    }

    return {
      title: cwdBase ? `${agent}: ${cwdBase}` : agent,
      detail: usefulProcess(info?.processName),
      paneCount,
      statusKind: info?.aiStatusKind ?? null,
    };
  }

  const tmuxName = tmuxSessionName(attach, tmuxSessions);
  if (tmuxName) {
    return {
      title: `tmux: ${tmuxName}`,
      detail: sshTargetForLeaf(focusedLeaf),
      paneCount,
    };
  }

  const sshTarget = sshTargetForLeaf(focusedLeaf);
  if (sshTarget || info?.agent === "ssh") {
    return {
      title: sshTarget ?? "ssh",
      detail: sshCwdDetail(info?.cwd ?? focusedLeaf?.lastCwd),
      paneCount,
    };
  }

  const title = usefulTitle(info?.terminalTitle);
  if (title) {
    return { title, detail: cwdBase, paneCount };
  }

  const process = usefulProcess(info?.processName);
  if (process) {
    return {
      title: cwdBase ? `${process}: ${cwdBase}` : process,
      detail: info?.command ?? null,
      paneCount,
    };
  }

  if (cwdBase) return { title: cwdBase, detail: compactPath(info?.cwd ?? focusedLeaf?.lastCwd ?? ""), paneCount };
  return { title: workspace.name, detail: null, paneCount };
};
