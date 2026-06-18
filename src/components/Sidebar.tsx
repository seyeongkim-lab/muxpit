import { useWorkspaceStore, collectLeafIds, type LayoutNode, type LeafNode, type Workspace } from "../stores/workspace";
import { useWorkspaceInfoStore } from "../hooks/useWorkspaceInfo";
import { useNotificationStore } from "../stores/notifications";
import { useSshHostsStore, type SshHost } from "../stores/sshHosts";
import { useTmuxSessionsStore } from "../stores/tmuxSessions";
import { useSettingsStore } from "../stores/settings";
import { useHistoryStore } from "../stores/history";
import { destroyAllTerminals } from "./terminalRegistry";
import { SidebarMonitor } from "./SidebarMonitor";
import { SidebarClaude } from "./SidebarClaude";
import { SidebarTmuxSessions } from "./SidebarTmuxSessions";
import { useMonitorStore, type MonitorSnapshot } from "../stores/monitor";
import { useState, useRef } from "react";
import type { SshConnection } from "../utils/sshConnection";

interface SidebarMonitorInfo {
  monitorId: string;
  sshTarget: string;
  sshCommand: string;
  sshConnection?: SshConnection;
}

interface SidebarProps {
  onOpenSettings?: () => void;
  onOpenSshPanel?: () => void;
  onEditHost?: (hostId: string) => void;
  onConnectHost?: (host: SshHost) => void;
  monitor?: SidebarMonitorInfo | null;
  onCloseMonitor?: () => void;
  onViewClaudeSession?: (sshTarget: string, project: string, projectPath: string | undefined, sessionId: string, sshConnection?: SshConnection) => void;
  onResumeClaudeSession?: (sshCommand: string, projectPath: string, sessionId: string, sshConnection?: SshConnection) => void;
  gridView?: boolean;
  onToggleGridView?: () => void;
}

const collectTerminalLeaves = (node: LayoutNode): LeafNode[] => {
  if (node.type === "leaf") return [node];
  if (node.type === "split") return [...collectTerminalLeaves(node.children[0]), ...collectTerminalLeaves(node.children[1])];
  return [];
};

const isSshLeaf = (leaf: LeafNode): boolean => {
  if (leaf.tmuxSession || leaf.sshCommand) return true;
  return /^\s*ssh\b/i.test(leaf.command ?? "");
};

const extractSshTarget = (command: string | undefined): string | null => {
  if (!command) return null;
  for (const part of command.split(/\s+/)) {
    const cleaned = part.replace(/^["']|["']$/g, "");
    if (cleaned.startsWith("-") || cleaned.toLowerCase() === "ssh") continue;
    if (cleaned.includes("@")) return cleaned;
  }
  const match = command.match(/(\S+@\S+)/);
  return match ? match[1].replace(/^["']|["']$/g, "") : null;
};

const getWorkspaceSshTarget = (workspace: Workspace): string | null => {
  for (const leaf of collectTerminalLeaves(workspace.layout)) {
    if (leaf.aiSshTarget) return leaf.aiSshTarget;
    const target = extractSshTarget(leaf.command) ?? extractSshTarget(leaf.sshCommand);
    if (target) return target;
  }
  return null;
};

const compactPath = (path: string): string =>
  path
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~");

const formatMemory = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
};

export const Sidebar = ({ onOpenSettings, onOpenSshPanel, onEditHost, onConnectHost, monitor, onCloseMonitor, onViewClaudeSession, onResumeClaudeSession, gridView, onToggleGridView }: SidebarProps) => {
  const { workspaces, activeId, addWorkspace, removeWorkspace, setActive, renameWorkspace, reorderWorkspaces } =
    useWorkspaceStore();
  const infoMap = useWorkspaceInfoStore((s) => s.info);
  const notifications = useNotificationStore((s) => s.notifications);
  const togglePanel = useNotificationStore((s) => s.togglePanel);
  const markRead = useNotificationStore((s) => s.markRead);
  const sshHosts = useSshHostsStore((s) => s.hosts);
  const tmuxAttach = useTmuxSessionsStore((s) => s._attach);
  const sessionListMetadata = useSettingsStore((s) => s.sessionListMetadata);
  const historyEntries = useHistoryStore((s) => s.entries);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedHostIds, setSelectedHostIds] = useState<Set<string>>(new Set());
  const dragFromIdxRef = useRef<number | null>(null);
  const [dragFromIdx, setDragFromIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

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
      <div className="wmux-sidebar-header" style={styles.header}>
        <span className="wmux-logo">wmux</span>
        <div style={styles.headerBtns}>
          <button className="wmux-btn" onClick={handleAdd} style={styles.addBtn} title="New workspace (Ctrl+Shift+T)">
            +
          </button>
          <button
            className="wmux-btn"
            onClick={onToggleGridView}
            style={{ ...styles.addBtn, ...(gridView ? { backgroundColor: "#313244", borderColor: "#89b4fa", color: "#cdd6f4" } : {}) }}
            title="Grid overview (Ctrl+Shift+G)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
          </button>
          <button className="wmux-btn" onClick={onOpenSettings} style={styles.addBtn} title="Settings (Ctrl+,)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </div>

      {/* SSH Hosts list */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <span className="wmux-section-label">HOSTS</span>
          <button
            className="wmux-btn"
            onClick={() => onOpenSshPanel?.()}
            style={styles.sectionAction}
            title="Manage SSH Hosts"
          >
            +
          </button>
        </div>
        <div style={styles.hostList}>
          {sshHosts.length === 0 && (
            <div style={styles.hostEmpty} onClick={() => onOpenSshPanel?.()}>
              + Add host
            </div>
          )}
          {sshHosts.map((host) => {
            const isSelected = selectedHostIds.has(host.id);
            const target = `${host.user}@${host.host}${host.port !== 22 ? `:${host.port}` : ""}`;
            const dotColor = host.color ?? "#89b4fa";
            return (
              <div
                key={host.id}
                className="wmux-host-row"
                style={{
                  ...styles.hostRow,
                  ...(isSelected ? styles.hostRowSelected : {}),
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
                title={`${host.name} — ${target}\nCtrl+Click to multi-select`}
              >
                <span
                  className="wmux-host-dot"
                  style={{
                    ...styles.hostDot,
                    backgroundColor: dotColor,
                    color: dotColor,
                  }}
                />
                <span style={styles.hostName}>{host.name}</span>
                <span style={styles.hostTarget}>{target}</span>
                <button
                  className="wmux-btn"
                  style={styles.hostEditBtn}
                  title="Edit host"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditHost?.(host.id);
                  }}
                >
                  ✎
                </button>
              </div>
            );
          })}
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

      <div style={styles.sessionSection}>
        <div style={styles.sectionHeader}>
          <span className="wmux-section-label">SESSIONS</span>
        </div>
        <div style={styles.list}>
          {workspaces.map((ws, i) => {
            const info = infoMap[ws.id];
            const isActive = ws.id === activeId;
            const paneCount = collectLeafIds(ws.layout).length;
            const terminalLeaves = collectTerminalLeaves(ws.layout);
            const isSsh = terminalLeaves.some(isSshLeaf) || !!tmuxAttach[ws.id];
            const sshTarget = getWorkspaceSshTarget(ws);
            const lastCommand = (() => {
              for (let idx = historyEntries.length - 1; idx >= 0; idx--) {
                if (historyEntries[idx].workspaceId === ws.id) return historyEntries[idx].command;
              }
              return null;
            })();
            const metaItems: { label: string; style: React.CSSProperties; title?: string }[] = [];
            const pushMeta = (label: string | null | undefined, style: React.CSSProperties, title?: string) => {
              if (label) metaItems.push({ label, style, title });
            };

            if (sessionListMetadata.agent) {
              pushMeta(isSsh ? "ssh" : info?.agent ?? "shell", styles.metaAgent);
            }
            if (isSsh) {
              if (sessionListMetadata.sshTarget) pushMeta(sshTarget, styles.metaSsh, sshTarget ?? undefined);
              if (sessionListMetadata.tmuxSession && tmuxAttach[ws.id]) {
                pushMeta(`tmux:${tmuxAttach[ws.id].wrapperSession}`, styles.metaTmux);
              }
            } else {
              if (sessionListMetadata.cwd && info?.cwd) pushMeta(compactPath(info.cwd), styles.metaItem, info.cwd);
              if (sessionListMetadata.git && info?.gitBranch) {
                pushMeta(`${info.gitBranch}${info.gitDirty ? " *" : ""}`, styles.branch);
              }
              if (sessionListMetadata.ports && info?.ports && info.ports.length > 0) {
                pushMeta(`:${info.ports.join(", :")}`, styles.ports);
              }
              if (sessionListMetadata.process && info?.processName && !info.agent) {
                pushMeta(info.processName, styles.metaProcess, info.command ?? undefined);
              }
              if (sessionListMetadata.memory && info?.memoryBytes) {
                pushMeta(formatMemory(info.memoryBytes), styles.metaMemory);
              }
              if (sessionListMetadata.lastCommand && lastCommand) {
                pushMeta(`last: ${lastCommand}`, styles.metaCommand, lastCommand);
              }
            }
            if (sessionListMetadata.panes && paneCount > 1 && !tmuxAttach[ws.id]) {
              pushMeta(`${paneCount} panes`, styles.panes);
            }
            const wsUnread = notifications.filter(
              (n) => n.workspaceId === ws.id && !n.read,
            ).length;
            const isDragging = dragFromIdx === i;
            const isDropTarget = dragOverIdx === i && dragFromIdx !== null && dragFromIdx !== i;

            return (
              <div key={ws.id}>
              <div
                className={`wmux-ws-item${isActive ? " wmux-ws-active" : ""}`}
                draggable={editingId !== ws.id}
                onDragStart={(e) => {
                  dragFromIdxRef.current = i;
                  setDragFromIdx(i);
                  e.dataTransfer.effectAllowed = "move";
                  // WebView2 / WKWebView require setData to actually initiate the drag
                  e.dataTransfer.setData("text/plain", ws.id);
                }}
                onDragOver={(e) => {
                  if (dragFromIdxRef.current === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dragOverIdx !== i) setDragOverIdx(i);
                }}
                onDragLeave={() => {
                  if (dragOverIdx === i) setDragOverIdx(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragFromIdxRef.current;
                  if (from !== null && from !== i) {
                    reorderWorkspaces(from, i);
                  }
                  dragFromIdxRef.current = null;
                  setDragFromIdx(null);
                  setDragOverIdx(null);
                }}
                onDragEnd={() => {
                  dragFromIdxRef.current = null;
                  setDragFromIdx(null);
                  setDragOverIdx(null);
                }}
                onClick={() => { setActive(ws.id); markRead(ws.id); }}
                style={{
                  ...styles.item,
                  ...(isActive ? styles.itemActive : {}),
                  ...(wsUnread > 0 ? styles.itemUnread : {}),
                  ...(isDragging ? styles.itemDragging : {}),
                  ...(isDropTarget ? styles.itemDropTarget : {}),
                }}
              >
                {isActive && <span className="wmux-active-bar" />}
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
                      className="wmux-btn"
                      onClick={(e) => handleClose(e, ws.id)}
                      style={styles.closeBtn}
                      title="Close workspace"
                    >
                      x
                    </button>
                  </div>

                  {/* Metadata */}
                  <div style={styles.meta}>
                    {metaItems.map((item, idx) => (
                      <span key={`${item.label}-${idx}`} style={item.style} title={item.title}>
                        {item.label}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              {/* Sibling, NOT child of the draggable ws-item: HTML5 drag would
                  otherwise hijack mousedown on session rows. */}
              {tmuxAttach[ws.id] && (
                <SidebarTmuxSessions
                  wsId={ws.id}
                  wrapperSession={tmuxAttach[ws.id].wrapperSession}
                />
              )}
              </div>
            );
          })}
        </div>
      </div>


      {monitor && latestSnapshot && (latestSnapshot.claudeSessions?.length ?? 0) > 0 && (
        <SidebarClaude
          sessions={latestSnapshot.claudeSessions}
          sshTarget={monitor.sshTarget}
          onViewSession={(project, projectPath, sessionId) => onViewClaudeSession?.(monitor.sshTarget, project, projectPath, sessionId, monitor.sshConnection)}
          onResumeSession={(projectPath, sessionId) => onResumeClaudeSession?.(monitor.sshCommand, projectPath, sessionId, monitor.sshConnection)}
        />
      )}

      {monitor && onCloseMonitor && (
        <SidebarMonitor
          monitorId={monitor.monitorId}
          sshTarget={monitor.sshTarget}
          sshCommand={monitor.sshCommand}
          sshConnection={monitor.sshConnection}
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
    backgroundColor: "var(--wmux-bg)",
    borderRight: "1px solid var(--wmux-hairline)",
    display: "flex",
    flexDirection: "column",
    userSelect: "none",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 12px 8px",
  },
  headerBtns: {
    display: "flex",
    gap: 4,
  },
  // Logo styling moved to .wmux-logo.
  logo: {},
  addBtn: {
    background: "var(--wmux-bg-elev)",
    border: "1px solid var(--wmux-hairline-strong)",
    borderRadius: 6,
    color: "var(--wmux-subtext)",
    fontSize: 18,
    width: 28,
    height: 28,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
  },
  sessionSection: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    minHeight: 0,
    overflow: "hidden",
  },
  list: {
    flex: 1,
    overflowY: "auto",
    padding: "2px 0",
  },
  item: {
    padding: "8px 12px 8px 14px",
    cursor: "grab",
    color: "var(--wmux-subtext)",
    fontSize: 14,
    transition: "background 0.1s, opacity 0.1s",
  },
  itemActive: {
    backgroundColor: "var(--wmux-accent-soft)",
    color: "var(--wmux-text)",
  },
  itemUnread: {
    backgroundColor: "rgba(249, 226, 175, 0.12)",
    boxShadow: "inset 0 0 0 1px rgba(249, 226, 175, 0.35)",
    color: "var(--wmux-text)",
  },
  itemDragging: {
    opacity: 0.4,
  },
  itemDropTarget: {
    borderTop: "2px solid var(--wmux-accent)",
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
    color: "var(--wmux-subtext)",
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
    background: "var(--wmux-bg-soft)",
    border: "1px solid var(--wmux-accent)",
    borderRadius: 3,
    color: "var(--wmux-text)",
    fontSize: 14,
    padding: "1px 4px",
    flex: 1,
    outline: "none",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "var(--wmux-subtext)",
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
    minWidth: 0,
  },
  metaItem: {
    color: "var(--wmux-subtext)",
    fontSize: 12,
    fontFamily: "monospace",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  metaAgent: {
    color: "#89b4fa",
    fontSize: 12,
    fontFamily: "monospace",
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
    color: "var(--wmux-subtext)",
    fontSize: 12,
  },
  ports: {
    color: "#94e2d5",
    fontSize: 12,
    fontFamily: "monospace",
  },
  metaProcess: {
    color: "#cba6f7",
    fontSize: 12,
    fontFamily: "monospace",
  },
  metaMemory: {
    color: "#fab387",
    fontSize: 12,
    fontFamily: "monospace",
  },
  metaSsh: {
    color: "#89dceb",
    fontSize: 12,
    fontFamily: "monospace",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  metaTmux: {
    color: "#f9e2af",
    fontSize: 12,
    fontFamily: "monospace",
  },
  metaCommand: {
    color: "var(--wmux-subtext)",
    fontSize: 12,
    fontFamily: "monospace",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  badge: {
    backgroundColor: "var(--wmux-accent)",
    color: "var(--wmux-bg)",
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
    borderTop: "1px solid var(--wmux-hairline)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  footerText: {
    color: "var(--wmux-subtext)",
    fontSize: 12,
  },
  notifBadge: {
    color: "#f38ba8",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },

  // Section (shared by HOSTS and SESSIONS)
  section: {
    borderBottom: "1px solid var(--wmux-hairline)",
    display: "flex",
    flexDirection: "column" as const,
    flexShrink: 0,
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 12px 5px",
  },
  sectionLabel: {
    color: "var(--wmux-subtext)",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0,
    fontFamily: "'JetBrains Mono', monospace",
  },
  sectionAction: {
    background: "var(--wmux-bg-elev)",
    border: "1px solid var(--wmux-hairline)",
    borderRadius: 4,
    color: "var(--wmux-subtext)",
    fontSize: 13,
    width: 18,
    height: 18,
    cursor: "pointer",
    lineHeight: 1,
    padding: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  // Host list (vertical, 1-line rows)
  hostList: {
    display: "flex",
    flexDirection: "column" as const,
    paddingBottom: 6,
    maxHeight: 180,
    overflowY: "auto" as const,
  },
  hostRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "5px 12px 5px 14px",
    cursor: "pointer",
  },
  hostRowSelected: {
    backgroundColor: "var(--wmux-accent-mid)",
  },
  hostDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },
  hostName: {
    color: "var(--wmux-text)",
    fontSize: 13,
    flexShrink: 0,
    maxWidth: 80,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  hostTarget: {
    color: "var(--wmux-subtext)",
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
    marginLeft: "auto",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    minWidth: 0,
  },
  hostEmpty: {
    color: "var(--wmux-subtext)",
    fontSize: 12,
    padding: "8px 12px",
    cursor: "pointer",
    fontStyle: "italic" as const,
  },
  hostEditBtn: {
    background: "transparent",
    border: "none",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
    fontSize: 12,
    padding: "2px 6px",
    marginLeft: 2,
    flexShrink: 0,
    lineHeight: 1,
  },

  connectBar: {
    padding: "4px 10px",
    borderBottom: "1px solid var(--wmux-hairline)",
  },
  connectAllBtn: {
    background: "var(--wmux-accent)",
    border: "none",
    borderRadius: 3,
    color: "var(--wmux-bg)",
    fontSize: 12,
    fontWeight: 600,
    padding: "4px 8px",
    cursor: "pointer",
    width: "100%",
  },
};
