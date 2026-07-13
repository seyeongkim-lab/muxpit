import { useState } from "react";
import { useLaunchProfileStore } from "../stores/launchProfiles.ts";
import { useWorkspaceInfoStore } from "../hooks/useWorkspaceInfo.ts";
import { useWorkspaceStore } from "../stores/workspace.ts";

interface LaunchProfilesPanelProps {
  open: boolean;
  onClose: () => void;
}

export const LaunchProfilesPanel = ({ open, onClose }: LaunchProfilesPanelProps) => {
  const profiles = useLaunchProfileStore((state) => state.profiles);
  const saveWorkspace = useLaunchProfileStore((state) => state.saveWorkspace);
  const launch = useLaunchProfileStore((state) => state.launch);
  const remove = useLaunchProfileStore((state) => state.remove);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  if (!open) return null;

  const saveCurrent = () => {
    const workspaceState = useWorkspaceStore.getState();
    const workspace = workspaceState.workspaces.find(
      (candidate) => candidate.id === workspaceState.activeId,
    );
    if (!workspace) {
      setError("No active workspace");
      return;
    }
    const saved = saveWorkspace(
      name || workspace.name,
      workspace,
      useWorkspaceInfoStore.getState().leafCwds[workspace.id],
    );
    if (!saved) {
      setError("Monitor and session viewer panes cannot be saved in a profile");
      return;
    }
    setName("");
    setError("");
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(event) => event.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Launch profiles</span>
          <button className="wmux-btn" onClick={onClose} style={styles.closeButton}>x</button>
        </div>
        <div style={styles.saveRow}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Profile name"
            style={styles.input}
          />
          <button className="wmux-btn" onClick={saveCurrent} style={styles.primaryButton}>
            Save current
          </button>
        </div>
        {error && <div style={styles.error}>{error}</div>}
        <div style={styles.list}>
          {profiles.length === 0 ? (
            <div style={styles.empty}>No saved profiles</div>
          ) : profiles.map((profile) => (
            <div key={profile.id} style={styles.row}>
              <button
                className="wmux-btn"
                onClick={() => { launch(profile.id); onClose(); }}
                style={styles.launchButton}
              >
                <span style={styles.profileName}>{profile.name}</span>
                <span style={styles.profileTime}>
                  {new Date(profile.createdAt).toLocaleString()}
                </span>
              </button>
              <button
                className="wmux-btn"
                onClick={() => remove(profile.id)}
                style={styles.removeButton}
                title="Remove profile"
              >
                x
              </button>
            </div>
          ))}
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
    width: 520,
    maxHeight: "72vh",
    display: "flex",
    flexDirection: "column",
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
  saveRow: { display: "flex", gap: 8, padding: 12 },
  input: {
    flex: 1,
    minWidth: 0,
    padding: "7px 9px",
    color: "var(--wmux-text)",
    background: "var(--wmux-bg)",
    border: "1px solid var(--wmux-hairline-strong)",
  },
  primaryButton: {
    padding: "7px 10px",
    color: "var(--wmux-text)",
    background: "var(--wmux-accent)",
    border: "1px solid var(--wmux-accent)",
  },
  error: { padding: "0 12px 10px", color: "#f38ba8", fontSize: 12 },
  list: { overflowY: "auto", padding: "0 12px 12px" },
  empty: { padding: 20, textAlign: "center", color: "var(--wmux-subtext)", fontSize: 12 },
  row: { display: "flex", gap: 6, marginTop: 6 },
  launchButton: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "9px 10px",
    color: "var(--wmux-text)",
    background: "var(--wmux-bg)",
    border: "1px solid var(--wmux-hairline)",
    textAlign: "left",
  },
  profileName: { fontSize: 13 },
  profileTime: { fontSize: 10, color: "var(--wmux-subtext)" },
  removeButton: {
    width: 32,
    color: "var(--wmux-subtext)",
    background: "var(--wmux-bg)",
    border: "1px solid var(--wmux-hairline)",
  },
};
