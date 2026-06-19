import { useState, useMemo } from "react";
import type { ClaudeSessionInfo } from "../stores/monitor";
import { useSidebarLayoutStore } from "../stores/sidebarLayout";

interface SidebarClaudeProps {
  sessions: ClaudeSessionInfo[];
  sshTarget: string;
  onViewSession: (project: string, projectPath: string, sessionId: string) => void;
  onResumeSession: (projectPath: string, sessionId: string) => void;
}

const COLORS = {
  bg: "#1e1e2e",
  surface: "#313244",
  text: "#cdd6f4",
  subtext: "#a6adc8",
  overlay: "#45475a",
  blue: "#89b4fa",
  green: "#a6e3a1",
  red: "#f38ba8",
  yellow: "#f9e2af",
  teal: "#94e2d5",
  mauve: "#cba6f7",
};

const formatRelativeTime = (isoStr: string | null): string => {
  if (!isoStr) return "";
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
};

const getProjectName = (projectPath: string): string => {
  const parts = projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || projectPath;
};

interface GroupedSessions {
  project: string;
  projectPath: string;
  sessions: ClaudeSessionInfo[];
}

export const SidebarClaude = ({ sessions, sshTarget: _sshTarget, onViewSession, onResumeSession }: SidebarClaudeProps) => {
  const [collapsed, setCollapsed] = useState(false);

  const grouped = useMemo((): GroupedSessions[] => {
    const map = new Map<string, GroupedSessions>();
    for (const s of sessions) {
      const existing = map.get(s.project);
      if (existing) {
        existing.sessions.push(s);
      } else {
        map.set(s.project, {
          project: s.project,
          projectPath: s.projectPath,
          sessions: [s],
        });
      }
    }
    return Array.from(map.values());
  }, [sessions]);

  const height = useSidebarLayoutStore((s) => s.claudeHeight);
  const setHeight = useSidebarLayoutStore((s) => s.setClaudeHeight);

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (ev: MouseEvent) => setHeight(startH + (startY - ev.clientY));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (sessions.length === 0) return null;

  return (
    <div className="wmux-card" style={{ ...styles.container, height: collapsed ? undefined : height }}>
      <div style={styles.resizeHandle} onMouseDown={onResizeStart} title="Drag to resize" />
      <div style={styles.header} onClick={() => setCollapsed((c) => !c)}>
        <span style={styles.headerText}>Claude Sessions</span>
        <span style={styles.toggle}>{collapsed ? "\u25B6" : "\u25BC"}</span>
      </div>

      {!collapsed && (
        <div style={styles.body}>
          {grouped.map((g) => (
            <div key={g.project}>
              <div style={styles.projectRow}>
                <span style={styles.projectIcon}>{"\uD83D\uDCC2"}</span>
                <span style={styles.projectName}>{getProjectName(g.projectPath)}</span>
              </div>
              {g.sessions.map((s) => (
                <div
                  key={s.sessionId}
                  style={styles.sessionRow}
                  onClick={() => onViewSession(s.project, s.projectPath, s.sessionId)}
                  onDoubleClick={() => onResumeSession(s.projectPath, s.sessionId)}
                  title={`Session: ${s.sessionId}\nMessages: ${s.messageCount}\nDouble-click to resume`}
                >
                  <span style={styles.sessionDot}>{"\u2022"}</span>
                  <span style={styles.sessionId}>{s.sessionId.slice(0, 8)}</span>
                  <span style={styles.sessionTime}>{formatRelativeTime(s.lastActivity)}</span>
                  <button
                    style={styles.resumeBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      onResumeSession(s.projectPath, s.sessionId);
                    }}
                    title="Resume session"
                  >
                    {"\u25B6"}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
    flexShrink: 0,
    display: "flex",
    flexDirection: "column" as const,
    position: "relative",
  },
  resizeHandle: {
    position: "absolute",
    top: -2,
    left: 0,
    right: 0,
    height: 6,
    cursor: "ns-resize",
    zIndex: 1,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "5px 10px",
    background: "var(--wmux-bg-elev)",
    borderBottom: "1px solid var(--wmux-hairline)",
    cursor: "pointer",
    userSelect: "none",
  },
  headerText: {
    color: "var(--wmux-accent-2)",
    fontWeight: 600,
    fontSize: 12,
  },
  toggle: {
    color: "var(--wmux-subtext)",
    fontSize: 10,
  },
  body: {
    padding: "4px 0",
    flex: 1,
    minHeight: 0,
    overflowY: "auto" as const,
  },
  projectRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "3px 8px",
  },
  projectIcon: {
    fontSize: 12,
  },
  projectName: {
    color: "var(--wmux-text)",
    fontSize: 12,
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  sessionRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 8px 2px 20px",
    cursor: "pointer",
    transition: "background 0.1s",
  },
  sessionDot: {
    color: COLORS.green,
    fontSize: 14,
    lineHeight: 1,
    flexShrink: 0,
  },
  sessionId: {
    color: "var(--wmux-subtext)",
    fontSize: 11,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  sessionTime: {
    color: "var(--wmux-subtext)",
    fontSize: 10,
    flexShrink: 0,
  },
  resumeBtn: {
    background: "none",
    border: "none",
    color: COLORS.green,
    fontSize: 10,
    cursor: "pointer",
    padding: "0 2px",
    lineHeight: 1,
    flexShrink: 0,
    opacity: 0.6,
  },
};
