import { useWorkspaceStore, collectLeafIds } from "../stores/workspace";
import { useWorkspaceInfoStore } from "../hooks/useWorkspaceInfo";
import { useNotificationStore } from "../stores/notifications";
import { useSshHostsStore, type SshHost } from "../stores/sshHosts";
import { destroyAllTerminals } from "./Terminal";
import { SidebarMonitor } from "./SidebarMonitor";
import { SidebarClaude } from "./SidebarClaude";
import { useMonitorStore, type MonitorSnapshot } from "../stores/monitor";
import { useState } from "react";

interface SidebarMonitorInfo {
  monitorId: string;
  sshTarget: string;
}

interface SidebarProps {
  onOpenSettings?: () => void;
  onOpenSshPanel?: () => void;
  onConnectHost?: (host: SshHost) => void;
  monitor?: SidebarMonitorInfo | null;
  onCloseMonitor?: () => void;
  onViewClaudeSession?: (sshTarget: string, project: string, sessionId: string) => void;
  onResumeClaudeSession?: (sshTarget: string, projectPath: string, sessionId: string) => void;
}

export const Sidebar = ({ onOpenSettings, onOpenSshPanel, onConnectHost, monitor, onCloseMonitor, onViewClaudeSession, onResumeClaudeSession }: SidebarProps) => {
  const { workspaces, activeId, addWorkspace, removeWorkspace, setActive, renameWorkspace } =
    useWorkspaceStore();
  const infoMap = useWorkspaceInfoStore((s) => s.info);
  const notifications = useNotificationStore((s) => s.notifications);
  const togglePanel = useNotificationStore((s) => s.togglePanel);
  const markRead = useNotificationStore((s) => s.markRead);
  const sshHosts = useSshHostsStore((s) => s.hosts);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedHostIds, setSelectedHostIds] = useState<Set<string>>(new Set());

  const monitorSeries = useMonitorStore((s) => monitor ? s.series[monitor.monitorId] : undefined);
  const latestSnapshot = monitorSeries?.[monitorSeries.length - 1] as MonitorSnapshot | undefined;
  const totalUnread = notifications.filter((n) => !n.read).length;
  const [editName, setEditName] = useState("");

  const handleAdd = () => addWorkspace();

  const handleClose = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const ws = workspaces.find((w) => w.id === id);
    if (ws) destroyAllTerminals(collectLeafIds(ws.layout));
    removeWorkspace(id);
  };

  const handleDoubleClick = (id: string, name: string) => {
    setEditingId(id);
    setEditName(name);
  };

  const handleRenameSubmit = (id: string) => {
    if (editName.trim()) renameWorkspace(id, editName.trim());
    setEditingId(null);
  };

  return (
    <div style={styles.sidebar}>
      <div style={styles.header}>
        <span style={styles.logo}>wmux</span>
        <div style={styles.headerBtns}>
          <button onClick={handleAdd} style={styles.addBtn} title="New workspace (Ctrl+Shift+T)">
            +
          </button>
          <button onClick={onOpenSettings} style={styles.addBtn} title="Settings (Ctrl+,)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>

      {/* SSH Hosts Grid */}
      <div style={styles.hostGrid}>
          {sshHosts.map((host) => {
            const isSelected = selectedHostIds.has(host.id);
            const initial = host.name.charAt(0).toUpperCase();
            return (
              <div
                key={host.id}
                style={{
                  ...styles.hostTile,
                  borderColor: isSelected ? "#89b4fa" : host.color ?? "#45475a",
                  backgroundColor: isSelected ? "#313244" : "transparent",
                }}
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey) {
                    setSelectedHostIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(host.id)) next.delete(host.id);
                      else next.add(host.id);
                      return next;
                    });
                  } else {
                    onConnectHost?.(host);
                  }
                }}
                title={`${host.name}\n${host.user}@${host.host}${host.port !== 22 ? `:${host.port}` : ""}\nCtrl+Click to multi-select`}
              >
                <span style={{ ...styles.hostIcon, color: host.color ?? "#89b4fa" }}>{initial}</span>
                <span style={styles.hostLabel}>{host.name}</span>
              </div>
            );
          })}
          <div
            style={styles.hostTileAdd}
            onClick={() => onOpenSshPanel?.()}
            title="Manage SSH Hosts"
          >
            <span style={styles.hostIconAdd}>+</span>
          </div>
        </div>

      {/* Multi-connect bar */}
      {selectedHostIds.size > 0 && (
        <div style={styles.connectBar}>
          <button
            style={styles.connectAllBtn}
            onClick={() => {
              selectedHostIds.forEach((id) => {
                const host = sshHosts.find((h) => h.id === id);
                if (host) onConnectHost?.(host);
              });
              setSelectedHostIds(new Set());
            }}
          >
            Connect {selectedHostIds.size} hosts
          </button>
        </div>
      )}

      <div style={styles.list}>
        {workspaces.map((ws, i) => {
          const info = infoMap[ws.id];
          const isActive = ws.id === activeId;
          const paneCount = collectLeafIds(ws.layout).length;
          const wsUnread = notifications.filter(
            (n) => n.workspaceId === ws.id && !n.read,
          ).length;

          return (
            <div
              key={ws.id}
              onClick={() => { setActive(ws.id); markRead(ws.id); }}
              style={{
                ...styles.item,
                ...(isActive ? styles.itemActive : {}),
              }}
            >
              <div style={styles.itemMain}>
                <div style={styles.itemRow}>
                  <span style={styles.index}>{i + 1}</span>
                  {editingId === ws.id ? (
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onBlur={() => handleRenameSubmit(ws.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRenameSubmit(ws.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      autoFocus
                      style={styles.renameInput}
                    />
                  ) : (
                    <span
                      style={styles.name}
                      onDoubleClick={() => handleDoubleClick(ws.id, ws.name)}
                    >
                      {ws.name}
                    </span>
                  )}
                  {wsUnread > 0 && (
                    <span style={styles.badge}>{wsUnread}</span>
                  )}
                  <button
                    onClick={(e) => handleClose(e, ws.id)}
                    style={styles.closeBtn}
                    title="Close workspace"
                  >
                    x
                  </button>
                </div>

                {/* Metadata */}
                <div style={styles.meta}>
                  {info?.gitBranch && (
                    <span style={styles.branch}>
                      {info.gitBranch}
                      {info.gitDirty && <span style={styles.dirty}> *</span>}
                    </span>
                  )}
                  {paneCount > 1 && (
                    <span style={styles.panes}>{paneCount} panes</span>
                  )}
                  {info?.ports && info.ports.length > 0 && (
                    <span style={styles.ports}>
                      :{info.ports.join(", :")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>


      {monitor && latestSnapshot && (latestSnapshot.claudeSessions?.length ?? 0) > 0 && (
        <SidebarClaude
          sessions={latestSnapshot.claudeSessions}
          sshTarget={monitor.sshTarget}
          onViewSession={(project, sessionId) => onViewClaudeSession?.(monitor.sshTarget, project, sessionId)}
          onResumeSession={(projectPath, sessionId) => onResumeClaudeSession?.(monitor.sshTarget, projectPath, sessionId)}
        />
      )}

      {monitor && onCloseMonitor && (
        <SidebarMonitor
          monitorId={monitor.monitorId}
          sshTarget={monitor.sshTarget}
          onClose={onCloseMonitor}
        />
      )}

      <div style={styles.footer}>
        <span style={styles.footerText}>{workspaces.length} sessions</span>
        {totalUnread > 0 && (
          <span style={styles.notifBadge} onClick={togglePanel} title="Notifications (Ctrl+Shift+I)">
            {totalUnread}
          </span>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    width: "16em",
    minWidth: "16em",
    height: "100%",
    backgroundColor: "#181825",
    borderRight: "1px solid #313244",
    display: "flex",
    flexDirection: "column",
    userSelect: "none",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 12px 8px",
    borderBottom: "1px solid #313244",
  },
  headerBtns: {
    display: "flex",
    gap: 4,
  },
  logo: {
    color: "#89b4fa",
    fontWeight: 700,
    fontSize: 17,
    fontFamily: "'JetBrains Mono', monospace",
  },
  addBtn: {
    background: "none",
    border: "1px solid #45475a",
    borderRadius: 4,
    color: "#a6adc8",
    fontSize: 18,
    width: 28,
    height: 28,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
  },
  list: {
    flex: 1,
    overflowY: "auto",
    padding: "4px 0",
  },
  item: {
    padding: "8px 12px",
    cursor: "pointer",
    color: "#a6adc8",
    fontSize: 14,
    borderLeft: "3px solid transparent",
    transition: "background 0.1s",
  },
  itemActive: {
    backgroundColor: "#1e1e2e",
    color: "#cdd6f4",
    borderLeftColor: "#89b4fa",
  },
  itemMain: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 3,
  },
  itemRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  index: {
    color: "#585b70",
    fontSize: 12,
    fontFamily: "monospace",
    minWidth: 16,
  },
  name: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  renameInput: {
    background: "#313244",
    border: "1px solid #89b4fa",
    borderRadius: 3,
    color: "#cdd6f4",
    fontSize: 14,
    padding: "1px 4px",
    flex: 1,
    outline: "none",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#585b70",
    fontSize: 13,
    cursor: "pointer",
    padding: "2px 4px",
    borderRadius: 3,
    lineHeight: 1,
    flexShrink: 0,
  },
  meta: {
    display: "flex",
    gap: 6,
    paddingLeft: 22,
    flexWrap: "wrap" as const,
  },
  branch: {
    color: "#a6e3a1",
    fontSize: 12,
    fontFamily: "monospace",
  },
  dirty: {
    color: "#f9e2af",
  },
  panes: {
    color: "#585b70",
    fontSize: 12,
  },
  ports: {
    color: "#94e2d5",
    fontSize: 12,
    fontFamily: "monospace",
  },
  badge: {
    backgroundColor: "#89b4fa",
    color: "#1e1e2e",
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 8,
    padding: "1px 5px",
    minWidth: 16,
    textAlign: "center" as const,
    flexShrink: 0,
  },
  footer: {
    padding: "8px 12px",
    borderTop: "1px solid #313244",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  footerText: {
    color: "#585b70",
    fontSize: 12,
  },
  notifBadge: {
    color: "#f38ba8",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },

  // SSH Hosts grid
  hostGrid: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 6,
    padding: "8px 10px",
    borderBottom: "1px solid #313244",
  },
  hostTile: {
    width: 46,
    height: 50,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    borderRadius: 6,
    border: "1px solid #45475a",
    cursor: "pointer",
    transition: "background 0.1s, border-color 0.1s",
  },
  hostIcon: {
    fontSize: 18,
    fontWeight: 700,
    fontFamily: "'JetBrains Mono', monospace",
    lineHeight: 1,
  },
  hostLabel: {
    fontSize: 9,
    color: "#a6adc8",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    maxWidth: 42,
    textAlign: "center" as const,
    lineHeight: 1,
  },
  hostTileAdd: {
    width: 46,
    height: 50,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    border: "1px dashed #45475a",
    cursor: "pointer",
  },
  hostIconAdd: {
    fontSize: 20,
    color: "#585b70",
    lineHeight: 1,
  },
  connectBar: {
    padding: "4px 10px",
    borderBottom: "1px solid #313244",
  },
  connectAllBtn: {
    background: "#89b4fa",
    border: "none",
    borderRadius: 3,
    color: "#1e1e2e",
    fontSize: 12,
    fontWeight: 600,
    padding: "4px 8px",
    cursor: "pointer",
    width: "100%",
  },
};
