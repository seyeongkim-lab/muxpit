// Selecting a session in the AI workbench should pull the matching terminal
// pane into focus, so the left (terminal) and right (chat) sides stay in step.

import {
  buildSshCommandWithRemoteCmdFromConnection,
  parseSshCommandLine,
  quoteCommandArg,
  sshConnectionToCommandLine,
  type SshConnection,
} from "./sshConnection.ts";

export interface WorkbenchLeafCandidate {
  workspaceId: string;
  leafId: string;
  contextKey: string;
  cwd?: string;
  focused: boolean;
}

const normalizeCwd = (cwd?: string): string | null => {
  if (!cwd) return null;
  const trimmed = cwd.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
};

// Pick the terminal pane to focus for a selected session: an exact
// working-directory match on the session's host wins, otherwise fall back to
// the host's already-focused pane, then any pane on that host. Returns null
// when the host has no open pane at all (selection then leaves the terminal
// side untouched).
export const pickWorkbenchFocusLeaf = (
  leaves: readonly WorkbenchLeafCandidate[],
  contextKey: string,
  sessionCwd?: string,
): WorkbenchLeafCandidate | null => {
  const contextLeaves = leaves.filter((leaf) => leaf.contextKey === contextKey);
  if (contextLeaves.length === 0) return null;
  const wanted = normalizeCwd(sessionCwd);
  if (wanted) {
    const matches = contextLeaves.filter((leaf) => normalizeCwd(leaf.cwd) === wanted);
    if (matches.length > 0) return matches.find((leaf) => leaf.focused) ?? matches[0];
  }
  return contextLeaves.find((leaf) => leaf.focused) ?? contextLeaves[0];
};

export interface WorkbenchPaneTarget {
  cwd?: string;
  sshCommand?: string;
  sshConnection?: SshConnection;
}

export interface WorkbenchPaneSpec {
  name: string;
  command?: string;
  sshConnection?: SshConnection;
  sshRemoteCommand?: string;
  launchCwd?: string;
}

// Describe the terminal pane to open when a session is selected for a host
// that has no open pane: a local shell launched in the session's directory,
// or an SSH connection that lands in it via a `cd` remote command.
export const buildWorkbenchPaneSpec = (
  label: string,
  target: WorkbenchPaneTarget,
  sessionCwd?: string,
): WorkbenchPaneSpec => {
  const connection = target.sshConnection ?? parseSshCommandLine(target.sshCommand)?.connection;
  if (!connection && !target.sshCommand) {
    const cwd = sessionCwd ?? target.cwd;
    const name = cwd ? cwd.replace(/\/+$/, "").split("/").pop() || label : label;
    return { name, ...(cwd ? { launchCwd: cwd } : {}) };
  }
  if (connection && sessionCwd) {
    const remote = `cd ${quoteCommandArg(sessionCwd)} && exec "\${SHELL:-sh}" -l`;
    return {
      name: label,
      command: buildSshCommandWithRemoteCmdFromConnection(connection, remote, true),
      sshConnection: connection,
      sshRemoteCommand: remote,
    };
  }
  return {
    name: label,
    command: target.sshCommand ?? (connection ? sshConnectionToCommandLine(connection) : undefined),
    sshConnection: connection,
  };
};
