// Selecting a session in the AI workbench should pull the matching terminal
// pane into focus, so the left (terminal) and right (chat) sides stay in step.

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
