import type {
  AiKind,
  LayoutNode,
  LeafNode,
  SplitDirection,
  Workspace,
} from "../stores/workspace.ts";
import type { SshConnection } from "./sshConnection.ts";
import { isLocalTerminalLeaf } from "./terminalSessionLayout.ts";

export type LaunchProfileLayout =
  | {
      type: "terminal";
      sourceSurfaceId?: string;
      command?: string;
      sshConnection?: SshConnection;
      sshRemoteCommand?: string;
      tmuxSession?: string;
      aiKind?: AiKind;
      aiSshTarget?: string;
      agentRole?: "subagent";
      parentSurfaceId?: string;
      agentLabel?: string;
      cwd?: string;
    }
  | { type: "browser"; url: string }
  | {
      type: "split";
      direction: SplitDirection;
      ratio: number;
      children: [LaunchProfileLayout, LaunchProfileLayout];
    };

export interface LaunchProfile {
  id: string;
  name: string;
  layout: LaunchProfileLayout;
  createdAt: number;
}

const terminalProfile = (
  node: LeafNode,
  cwdByLeaf: Record<string, string>,
): LaunchProfileLayout => {
  const command = node.command ?? node.sshCommand;
  const cwd = isLocalTerminalLeaf(node)
    ? cwdByLeaf[node.id] ?? node.profileCwd ?? node.lastCwd
    : undefined;
  return {
    type: "terminal",
    sourceSurfaceId: node.id,
    ...(command ? { command } : {}),
    ...(node.sshConnection ? { sshConnection: node.sshConnection } : {}),
    ...(node.sshRemoteCommand ? { sshRemoteCommand: node.sshRemoteCommand } : {}),
    ...(node.tmuxSession ? { tmuxSession: node.tmuxSession } : {}),
    ...(node.aiKind ? { aiKind: node.aiKind } : {}),
    ...(node.aiSshTarget ? { aiSshTarget: node.aiSshTarget } : {}),
    ...(node.agentRole ? { agentRole: node.agentRole } : {}),
    ...(node.parentSurfaceId ? { parentSurfaceId: node.parentSurfaceId } : {}),
    ...(node.agentLabel ? { agentLabel: node.agentLabel } : {}),
    ...(cwd ? { cwd } : {}),
  };
};

export const captureLaunchProfileLayout = (
  node: LayoutNode,
  cwdByLeaf: Record<string, string> = {},
): LaunchProfileLayout => {
  if (node.type === "leaf") return terminalProfile(node, cwdByLeaf);
  if (node.type === "browser") return { type: "browser", url: node.url };
  if (node.type === "split") {
    return {
      type: "split",
      direction: node.direction,
      ratio: node.ratio,
      children: [
        captureLaunchProfileLayout(node.children[0], cwdByLeaf),
        captureLaunchProfileLayout(node.children[1], cwdByLeaf),
      ],
    };
  }
  return { type: "terminal" };
};

const hasRuntimeOnlyNode = (node: LayoutNode): boolean => {
  if (node.type === "monitor" || node.type === "claudeSession") return true;
  if (node.type === "split") {
    return hasRuntimeOnlyNode(node.children[0]) || hasRuntimeOnlyNode(node.children[1]);
  }
  return false;
};

export const captureLaunchProfile = (
  name: string,
  workspace: Workspace,
  createdAt = Date.now(),
  cwdByLeaf: Record<string, string> = {},
): LaunchProfile | null => {
  const trimmed = name.trim();
  if (!trimmed || hasRuntimeOnlyNode(workspace.layout)) return null;
  return {
    id: `profile-${createdAt}-${workspace.id}`,
    name: trimmed,
    layout: captureLaunchProfileLayout(workspace.layout, cwdByLeaf),
    createdAt,
  };
};

const instantiate = (
  node: LaunchProfileLayout,
  nextId: () => string,
  sourceIds: Map<string, string>,
): { layout: LayoutNode; firstTerminalId?: string } => {
  if (node.type === "terminal") {
    const id = nextId();
    if (node.sourceSurfaceId) sourceIds.set(node.sourceSurfaceId, id);
    return {
      layout: {
        type: "leaf",
        id,
        ptyId: null,
        command: node.command,
        sshConnection: node.sshConnection,
        sshRemoteCommand: node.sshRemoteCommand,
        tmuxSession: node.tmuxSession,
        aiKind: node.aiKind,
        aiSshTarget: node.aiSshTarget,
        agentRole: node.agentRole,
        parentSurfaceId: node.parentSurfaceId,
        agentLabel: node.agentLabel,
        lastCwd: node.cwd,
        profileCwd: node.cwd,
      },
      firstTerminalId: id,
    };
  }
  if (node.type === "browser") {
    return { layout: { type: "browser", id: nextId(), url: node.url } };
  }
  const id = nextId();
  const left = instantiate(node.children[0], nextId, sourceIds);
  const right = instantiate(node.children[1], nextId, sourceIds);
  return {
    layout: {
      type: "split",
      id,
      direction: node.direction,
      ratio: node.ratio,
      children: [left.layout, right.layout],
    },
    firstTerminalId: left.firstTerminalId ?? right.firstTerminalId,
  };
};

export const materializeLaunchProfile = (
  profile: LaunchProfile,
  nextId: () => string,
): { layout: LayoutNode; focusedLeafId: string } =>
  instantiateLaunchProfileLayout(profile.layout, nextId);

export const instantiateLaunchProfileLayout = (
  node: LaunchProfileLayout,
  nextId: () => string,
): { layout: LayoutNode; focusedLeafId: string } => {
  const sourceIds = new Map<string, string>();
  const result = instantiate(node, nextId, sourceIds);
  const remapParentIds = (layout: LayoutNode): LayoutNode => {
    if (layout.type === "leaf") {
      return {
        ...layout,
        parentSurfaceId: layout.parentSurfaceId
          ? sourceIds.get(layout.parentSurfaceId)
          : undefined,
      };
    }
    if (layout.type !== "split") return layout;
    return {
      ...layout,
      children: [remapParentIds(layout.children[0]), remapParentIds(layout.children[1])],
    };
  };
  const layout = remapParentIds(result.layout);
  return {
    layout,
    focusedLeafId: result.firstTerminalId ?? layout.id,
  };
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validLayout = (value: unknown, depth = 0): value is LaunchProfileLayout => {
  if (!isObject(value) || depth > 32) return false;
  if (value.type === "terminal") return true;
  if (value.type === "browser") return typeof value.url === "string";
  if (value.type !== "split") return false;
  return (
    (value.direction === "horizontal" || value.direction === "vertical") &&
    typeof value.ratio === "number" &&
    value.ratio > 0 &&
    value.ratio < 1 &&
    Array.isArray(value.children) &&
    value.children.length === 2 &&
    validLayout(value.children[0], depth + 1) &&
    validLayout(value.children[1], depth + 1)
  );
};

export const parseLaunchProfiles = (raw: string | null): LaunchProfile[] => {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is LaunchProfile =>
        isObject(item) &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        typeof item.createdAt === "number" &&
        validLayout(item.layout),
    );
  } catch {
    return [];
  }
};
