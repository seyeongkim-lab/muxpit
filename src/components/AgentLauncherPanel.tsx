import { AI_KINDS, AI_LABEL, LOCAL_AI_COMMAND } from "../stores/aiCli";
import { useWorkspaceInfoStore } from "../hooks/useWorkspaceInfo";
import { useWorkspaceStore } from "../stores/workspace";
import { findTerminalLeaf, isLocalTerminalLeaf } from "../utils/terminalSessionLayout";

interface AgentLauncherPanelProps {
  open: boolean;
  onClose: () => void;
}

export const AgentLauncherPanel = ({ open, onClose }: AgentLauncherPanelProps) => {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeId = useWorkspaceStore((state) => state.activeId);
  const leafCwds = useWorkspaceInfoStore((state) => state.leafCwds);
  const workspaceInfo = useWorkspaceInfoStore((state) => state.info);
  const workspace = workspaces.find((candidate) => candidate.id === activeId);
  const leaf = workspace
    ? findTerminalLeaf(workspaces, workspace.id, workspace.focusedLeafId)
    : undefined;
  const localLeaf = leaf && isLocalTerminalLeaf(leaf) ? leaf : undefined;
  const cwd = workspace && localLeaf
    ? leafCwds[workspace.id]?.[localLeaf.id] ?? workspaceInfo[workspace.id]?.cwd
    : undefined;
  const canLaunch = !!workspace && !!localLeaf && !!cwd;

  if (!open) return null;

  const launch = (kind: (typeof AI_KINDS)[number]) => {
    if (!workspace || !localLeaf || !cwd) return;
    const state = useWorkspaceStore.getState();
    const newLeafId = state.splitLeafWithCommand(
      workspace.id,
      localLeaf.id,
      "vertical",
      LOCAL_AI_COMMAND[kind],
      { aiKind: kind, launchCwd: cwd },
    );
    state.setFocusedLeaf(workspace.id, newLeafId);
    onClose();
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(event) => event.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Open AI pane</span>
          <button className="wmux-btn" onClick={onClose} style={styles.closeButton}>x</button>
        </div>
        <div style={styles.content}>
          <div style={styles.cwdLabel}>Working directory</div>
          <div style={styles.cwd}>{cwd || "Current directory is not available"}</div>
          {!localLeaf && (
            <div style={styles.notice}>Select a local terminal pane. Remote AI panes use the pane toolbar.</div>
          )}
          {localLeaf && !cwd && (
            <div style={styles.notice}>Waiting for the terminal to report its current directory.</div>
          )}
          <div style={styles.grid}>
            {AI_KINDS.map((kind) => (
              <button
                key={kind}
                className="wmux-btn"
                onClick={() => launch(kind)}
                disabled={!canLaunch}
                style={{ ...styles.agentButton, ...(!canLaunch ? styles.disabled : {}) }}
              >
                <span style={styles.agentName}>{AI_LABEL[kind]}</span>
                <span style={styles.command}>{LOCAL_AI_COMMAND[kind]}</span>
              </button>
            ))}
          </div>
          <div style={styles.hint}>The CLI must already be installed and available in your shell PATH.</div>
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 110,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0, 0, 0, 0.45)",
  },
  panel: {
    width: 480,
    background: "var(--wmux-bg-elev)",
    border: "1px solid var(--wmux-hairline-strong)",
    boxShadow: "0 16px 48px rgba(0, 0, 0, 0.35)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 14px",
    borderBottom: "1px solid var(--wmux-hairline)",
  },
  title: { color: "var(--wmux-text)", fontSize: 14, fontWeight: 600 },
  closeButton: { border: "none", background: "transparent", color: "var(--wmux-subtext)" },
  content: { padding: 14 },
  cwdLabel: { color: "var(--wmux-subtext)", fontSize: 11, marginBottom: 5 },
  cwd: {
    padding: "8px 9px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--wmux-text)",
    background: "var(--wmux-bg)",
    border: "1px solid var(--wmux-hairline)",
    fontFamily: "var(--wmux-font-mono)",
    fontSize: 12,
  },
  notice: { marginTop: 9, color: "#f9e2af", fontSize: 12 },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 },
  agentButton: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 3,
    padding: "10px 11px",
    color: "var(--wmux-text)",
    background: "var(--wmux-bg)",
    border: "1px solid var(--wmux-hairline-strong)",
    textAlign: "left",
  },
  disabled: { opacity: 0.45, cursor: "not-allowed" },
  agentName: { fontSize: 13, fontWeight: 600 },
  command: { color: "var(--wmux-subtext)", fontSize: 10, fontFamily: "var(--wmux-font-mono)" },
  hint: { marginTop: 11, color: "var(--wmux-subtext)", fontSize: 11 },
};
