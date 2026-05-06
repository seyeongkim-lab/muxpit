import { useMemo, useState } from "react";
import { useTmuxSessionsStore, pickActiveSession, type TmuxSession } from "../stores/tmuxSessions";

interface Props {
  wsId: string;
  wrapperSession: string;
}

export const SidebarTmuxSessions = ({ wsId, wrapperSession }: Props) => {
  const entry = useTmuxSessionsStore((s) => s.byWs[wsId]);
  const switchTo = useTmuxSessionsStore((s) => s.switchTo);
  const createNew = useTmuxSessionsStore((s) => s.createNew);
  const killSession = useTmuxSessionsStore((s) => s.killSession);
  const refresh = useTmuxSessionsStore((s) => s.refresh);

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");

  const ordered = useMemo<TmuxSession[]>(() => {
    if (!entry) return [];
    const wrapper = entry.sessions.find((s) => s.name === wrapperSession);
    const rest = entry.sessions
      .filter((s) => s.name !== wrapperSession)
      .sort((a, b) => b.activity - a.activity);
    return wrapper ? [wrapper, ...rest] : rest;
  }, [entry, wrapperSession]);

  const active = entry ? pickActiveSession(entry.sessions, wrapperSession) : null;

  if (!entry) return null;

  const handleSwitch = (sessionId: string) => {
    void switchTo(wsId, sessionId).catch((e) => console.error("[wmux] switch session:", e));
  };

  const handleKill = (s: TmuxSession) => {
    const label = s.name === wrapperSession ? `wrapper "${s.name}"` : `"${s.name}"`;
    if (!window.confirm(`Kill tmux session ${label}?`)) return;
    void killSession(wsId, s.id).catch((e) => console.error("[wmux] kill session:", e));
  };

  const submitNew = () => {
    void createNew(wsId, newName.trim() || undefined)
      .catch((e) => console.error("[wmux] new session:", e))
      .finally(() => {
        setNewName("");
        setAdding(false);
      });
  };

  return (
    <div
      style={styles.container}
      // The parent .wmux-ws-item is draggable. The HTML5 drag system uses the
      // closest draggable ancestor, so unless this container also marks itself
      // draggable, mousedown on a session row starts a workspace drag and the
      // click never fires. We mark it draggable and immediately preventDefault
      // the dragstart so neither this nor the parent actually drags.
      draggable
      onDragStart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
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
              ...(isActive ? styles.rowActive : {}),
            }}
            onClick={() => !isActive && handleSwitch(s.id)}
            title={`${s.name} (${s.windows} window${s.windows === 1 ? "" : "s"})`}
          >
            <span style={{ ...styles.dot, opacity: isActive ? 1 : 0.35 }}>●</span>
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
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    paddingLeft: 22,
    paddingBottom: 4,
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
