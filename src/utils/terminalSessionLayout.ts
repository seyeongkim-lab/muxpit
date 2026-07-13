import type { AiKind, LeafNode, LayoutNode, Workspace } from "../stores/workspace.ts";
import type { AgentSessionBinding } from "./agentSession.ts";
import {
  parseSshCommandLine,
  sshConnectionToArgv,
  type SshConnection,
} from "./sshConnection.ts";

export interface TerminalSpawnSpec {
  command?: string;
  commandArgv?: string[];
  sshConnection?: SshConnection;
  cwd?: string;
  cwdSource?: "local" | "agent" | "profile";
  agentSession?: AgentSessionBinding;
}

export const isLocalTerminalLeaf = (node: LeafNode): boolean => {
  if (node.tmuxSession || node.sshCommand || node.sshConnection) return false;
  return !parseSshCommandLine(node.command);
};

export const terminalSpawnSpecFromLeaf = (node: LeafNode): TerminalSpawnSpec => {
  const parsed = parseSshCommandLine(node.command ?? node.sshCommand);
  const sshConnection = node.sshConnection && parsed?.connection?.ttyMode && !node.sshConnection.ttyMode
    ? { ...node.sshConnection, ttyMode: parsed.connection.ttyMode }
    : node.sshConnection ?? parsed?.connection;
  const sshRemoteCommand = node.sshRemoteCommand ?? parsed?.remoteCommand;
  const command = node.command ?? node.sshCommand;
  return {
    command,
    commandArgv: sshConnection
      ? sshConnectionToArgv(sshConnection, {
          preserveTtyMode: true,
          remoteCommand: sshRemoteCommand,
        })
      : undefined,
    sshConnection,
    cwd: node.agentSession?.cwd ?? node.profileCwd ?? (isLocalTerminalLeaf(node) ? node.lastCwd : undefined),
    cwdSource: node.agentSession?.cwd
      ? "agent"
      : node.profileCwd
        ? "profile"
        : isLocalTerminalLeaf(node) && node.lastCwd
          ? "local"
          : undefined,
    agentSession: node.agentSession,
  };
};

export const findTerminalLeaf = (
  workspaces: Workspace[],
  workspaceId: string,
  leafId: string,
): LeafNode | undefined => {
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return undefined;
  return findLeafNode(workspace.layout, leafId);
};

export const findTerminalSpawnSpec = (
  workspaces: Workspace[],
  workspaceId: string,
  leafId: string,
): TerminalSpawnSpec => {
  const leaf = findTerminalLeaf(workspaces, workspaceId, leafId);
  return leaf ? terminalSpawnSpecFromLeaf(leaf) : {};
};

export const findTerminalCloneFromPtyId = (
  workspaces: Workspace[],
  workspaceId: string,
  leafId: string,
): number | undefined =>
  findTerminalLeaf(workspaces, workspaceId, leafId)?.cloneFromPtyId;

export const findTerminalTmuxSession = (
  workspaces: Workspace[],
  workspaceId: string,
  leafId: string,
): string | undefined =>
  findTerminalLeaf(workspaces, workspaceId, leafId)?.tmuxSession;

export const findTerminalAiKind = (
  workspaces: Workspace[],
  workspaceId: string,
  leafId: string,
): AiKind | undefined =>
  findTerminalLeaf(workspaces, workspaceId, leafId)?.aiKind;

export const terminalLeafExists = (
  workspaces: Workspace[],
  workspaceId: string,
  leafId: string,
): boolean =>
  findTerminalLeaf(workspaces, workspaceId, leafId) !== undefined;

const findLeafNode = (node: LayoutNode, leafId: string): LeafNode | undefined => {
  if (node.type === "leaf") return node.id === leafId ? node : undefined;
  if (node.type === "split") {
    return findLeafNode(node.children[0], leafId) ?? findLeafNode(node.children[1], leafId);
  }
  return undefined;
};
