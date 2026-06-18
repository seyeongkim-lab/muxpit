import { useMemo, useState } from "react";
import { useTmuxSessionsStore, pickActiveSession, type TmuxSession } from "../stores/tmuxSessions";
import { useWorkspaceStore, hasTmuxLeaf } from "../stores/workspace";
import { ConfirmDialog } from "./ConfirmDialog";

interface Props {
  wsId: string;
  wrapperSession: string;
  /** Whether the parent workspace is the active one. Inactive workspaces dim
   * their active-session highlight so the sub-session list matches the dimmed
   * workspace name above it. */
  isWsActive: boolean;
}

export const SidebarTmuxSessions = ({ wsId, wrapperSession, isWsActive }: Props) => {
  const entry = useTmuxSessionsStore((s) => s.byWs[wsId]);
  const switchTo = useTmuxSessionsStore((s) => s.switchTo);
  const createNew = useTmuxSessionsStore((s) => s.createNew);
  const killSession = useTmuxSessionsStore((s) => s.killSession);
  const refresh = useTmuxSessionsStore((s) => s.refresh);
  const resumePolling = useTmuxSessionsStore((s) => s.resumePolling);
  const attachInfo = useTmuxSessionsStore((s) => s._attach[wsId]);
  const setActiveWs = useWorkspaceStore((s) => s.setActive);
  const addTmuxPane = useWorkspaceStore((s) => s.addTmuxPane);
  // Whether this workspace still has a live tmux-attached pane. When false (the
  // pane was closed), session rows open a fresh pane instead of switching the
  // — now absent — attached client.
  const hasLivePane = useWorkspaceStore((s) => {
    const w = s.workspaces.find((x) => x.id === wsId);
    return w ? hasTmuxLeaf(w.layout) : false;
  });

  // Open `sessionName` in a new pane attached via tmux-CC. The backend spawn
  // creates the session if it doesn't exist, so this also serves "+ new session".
  const openInNewPane = (sessionName: string) => {
    if (!attachInfo) return;
    setActiveWs(wsId);
    addTmuxPane(wsId, "horizontal", attachInfo.sshCommand, sessionName);
    resumePolling(wsId);
  };

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [killTarget, setKillTarget] = useState<TmuxSession | null>(null);

  const ordered = useMemo<TmuxSession[]>(() => {
    if (!entry) return [];
    const wrapper = entry.sessions.find((s) => s.name === wrapperSession);
    // Stable order by tmux session id (`$N` creation order) so switching
    // doesn't reshuffle the list — activity-desc made the just-clicked row
    // jump to position 2 on every poll.
    const idNum = (s: TmuxSession) => parseInt(s.id.replace(/^\$/, ""), 10) || 0;
    const rest = entry.sessions
      .filter((s) => s.name !== wrapperSession)
      .sort((a, b) => idNum(a) - idNum(b));
    return wrapper ? [wrapper, ...rest] : rest;
  }, [entry, wrapperSession]);

  const active = entry ? pickActiveSession(entry.sessions, wrapperSession) : null;

  if (!entry) return null;

  const handleSwitch = (sessionId: string) => {
    // Activate the workspace too so the user lands on the pane that's about
    // to display the new session.
    setActiveWs(wsId);
    void switchTo(wsId, sessionId).catch((e) => console.error("[wmux] switch session:", e));
  };

  const handleKill = (s: TmuxSession) => {
    setKillTarget(s);
  };

  const confirmKill = () => {
    if (!killTarget) return;
    const id = killTarget.id;
    setKillTarget(null);
    void killSession(wsId, id).catch((e) => console.error("[wmux] kill session:", e));
  };

  const submitNew = () => {
    // With no live pane there is no attached client to switch; open a pane
    // directly (empty name reopens the wmux wrapper session).
    if (!hasLivePane) {
      openInNewPane(newName.trim() || wrapperSession);
      setNewName("");
      setAdding(false);
      return;
    }
    void createNew(wsId, newName.trim() || undefined)
      .catch((e) => console.error("[wmux] new session:", e))
      .finally(() => {
        setNewName("");
        setAdding(false);
      });
  };

  return (
    <div
      className="wmux-tmux-sessions"
      style={styles.container}
      // Parent ws-item handles workspace drag; if we let its onDragStart fire
      // from inside this list, clicks get swallowed. Parent checks for this
      // className and bails out (see Sidebar.tsx).
      onMouseDown={(e) => e.stopPropagation()}
    >
      {entry.error && (
        <div style={styles.error} title={entry.error} onClick={() => void refresh(wsId)}>
          ! list failed (click to retry)
        </div>
      )}
      {ordered.length === 0 && !entry.loading && !entry.error && (
        <div style={styles.empty}>no sessions</div>
      )}
      {ordered.map((s) => {
        const isActive = active?.id === s.id;
        const isWrapper = s.name === wrapperSession;
        return (
          <div
            key={s.id}
            style={{
              ...styles.row,
              ...(isActive ? (isWsActive ? styles.rowActive : styles.rowActiveDim) : {}),
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (!hasLivePane) {
                openInNewPane(s.name);
              } else if (!isActive) {
                handleSwitch(s.id);
              }
            }}
            title={
              hasLivePane
                ? `${s.name} (${s.windows} window${s.windows === 1 ? "" : "s"})`
                : `Open ${s.name} in a new pane`
            }
          >
            <span style={{ ...styles.dot, opacity: isActive ? (isWsActive ? 1 : 0.5) : 0.35 }}>●</span>
            <span style={styles.name}>{s.name}</span>
            {isWrapper && <span style={styles.wrapperBadge}>wmux</span>}
            <span style={styles.windows}>{s.windows}w</span>
            <button
              className="wmux-btn"
              style={styles.killBtn}
              title="Kill session"
              onClick={(e) => {
                e.stopPropagation();
                handleKill(s);
              }}
            >
              x
            </button>
          </div>
        );
      })}
      {adding ? (
        <div style={styles.row}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitNew();
              if (e.key === "Escape") {
                setAdding(false);
                setNewName("");
              }
            }}
            onBlur={submitNew}
            placeholder="session name (optional)"
            autoFocus
            style={styles.input}
          />
        </div>
      ) : (
        <div
          style={styles.addRow}
          onClick={() => {
            setAdding(true);
            setNewName("");
          }}
        >
          + new session
        </div>
      )}
      <ConfirmDialog
        open={killTarget !== null}
        message={
          killTarget
            ? killTarget.name === wrapperSession
              ? `Kill the wmux wrapper session "${killTarget.name}"?\nThis will close the SSH connection.`
              : `Kill tmux session "${killTarget.name}"?`
            : ""
        }
        confirmLabel="Kill"
        destructive
        onConfirm={confirmKill}
        onCancel={() => setKillTarget(null)}
      />
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    // ws-item left padding (14) + index column (~22 incl gap) so rows align
    // visually under the workspace name.
    paddingLeft: 36,
    paddingBottom: 6,
    position: "relative" as const,
    zIndex: 1,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 12px 3px 6px",
    cursor: "pointer",
    fontSize: 12,
    color: "var(--wmux-subtext)",
    borderLeft: "2px solid transparent",
  },
  rowActive: {
    color: "var(--wmux-text)",
    backgroundColor: "var(--wmux-accent-soft)",
    borderLeftColor: "var(--wmux-accent)",
    cursor: "default",
  },
  // Active session of an inactive workspace: keep a faint marker but drop the
  // bright text / accent fill so it reads as dimmed like the workspace above.
  rowActiveDim: {
    borderLeftColor: "var(--wmux-hairline)",
    cursor: "default",
  },
  dot: {
    fontSize: 8,
    color: "var(--wmux-accent)",
    width: 10,
    flexShrink: 0,
    textAlign: "center" as const,
  },
  name: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  wrapperBadge: {
    color: "var(--wmux-subtext)",
    fontSize: 9,
    fontFamily: "'JetBrains Mono', monospace",
    backgroundColor: "var(--wmux-bg-elev)",
    border: "1px solid var(--wmux-hairline)",
    borderRadius: 3,
    padding: "0 4px",
    flexShrink: 0,
  },
  windows: {
    color: "var(--wmux-subtext)",
    fontSize: 10,
    fontFamily: "'JetBrains Mono', monospace",
    flexShrink: 0,
  },
  killBtn: {
    background: "transparent",
    border: "none",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
    fontSize: 11,
    padding: "0 4px",
    flexShrink: 0,
    lineHeight: 1,
  },
  addRow: {
    paddingLeft: 18,
    padding: "3px 12px 3px 18px",
    color: "var(--wmux-subtext)",
    fontSize: 11,
    fontStyle: "italic" as const,
    cursor: "pointer",
  },
  empty: {
    paddingLeft: 18,
    padding: "3px 12px 3px 18px",
    color: "var(--wmux-subtext)",
    fontSize: 11,
    fontStyle: "italic" as const,
  },
  error: {
    paddingLeft: 18,
    padding: "3px 12px 3px 18px",
    color: "#f38ba8",
    fontSize: 11,
    cursor: "pointer",
  },
  input: {
    flex: 1,
    background: "var(--wmux-bg-soft)",
    border: "1px solid var(--wmux-accent)",
    borderRadius: 3,
    color: "var(--wmux-text)",
    fontSize: 12,
    padding: "1px 4px",
    outline: "none",
  },
};
