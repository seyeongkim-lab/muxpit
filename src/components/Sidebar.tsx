import { useWorkspaceStore, collectLeafIds } from "../stores/workspace";
import { useWorkspaceInfoStore } from "../hooks/useWorkspaceInfo";
import { useNotificationStore } from "../stores/notifications";
import { destroyAllTerminals } from "./Terminal";
import { useState } from "react";

interface SidebarProps {
  onOpenSettings?: () => void;
}

export const Sidebar = ({ onOpenSettings }: SidebarProps) => {
  const { workspaces, activeId, addWorkspace, removeWorkspace, setActive, renameWorkspace } =
    useWorkspaceStore();
  const infoMap = useWorkspaceInfoStore((s) => s.info);
  const notifications = useNotificationStore((s) => s.notifications);
  const togglePanel = useNotificationStore((s) => s.togglePanel);
  const markRead = useNotificationStore((s) => s.markRead);
  const [editingId, setEditingId] = useState<string | null>(null);

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
        <button onClick={handleAdd} style={styles.addBtn} title="New workspace (Ctrl+Shift+T)">
          +
        </button>
      </div>

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
                  {workspaces.length > 1 && (
                    <button
                      onClick={(e) => handleClose(e, ws.id)}
                      style={styles.closeBtn}
                      title="Close workspace"
                    >
                      x
                    </button>
                  )}
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

      <div style={styles.footer}>
        <span style={styles.footerText}>{workspaces.length} sessions</span>
        <button onClick={onOpenSettings} style={styles.notifBtn} title="Settings (Ctrl+,)">
          S
        </button>
        <button onClick={togglePanel} style={styles.notifBtn} title="Notifications (Ctrl+Shift+I)">
          {totalUnread > 0 ? (
            <span style={styles.notifBadge}>{totalUnread}</span>
          ) : (
            "~"
          )}
        </button>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    width: "14em",
    minWidth: "14em",
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
  logo: {
    color: "#89b4fa",
    fontWeight: 700,
    fontSize: 15,
    fontFamily: "'JetBrains Mono', monospace",
  },
  addBtn: {
    background: "none",
    border: "1px solid #45475a",
    borderRadius: 4,
    color: "#a6adc8",
    fontSize: 16,
    width: 26,
    height: 26,
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
    fontSize: 13,
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
    fontSize: 11,
    fontFamily: "monospace",
    minWidth: 14,
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
    fontSize: 13,
    padding: "1px 4px",
    flex: 1,
    outline: "none",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#585b70",
    fontSize: 12,
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
    fontSize: 11,
    fontFamily: "monospace",
  },
  dirty: {
    color: "#f9e2af",
  },
  panes: {
    color: "#585b70",
    fontSize: 11,
  },
  ports: {
    color: "#94e2d5",
    fontSize: 11,
    fontFamily: "monospace",
  },
  badge: {
    backgroundColor: "#89b4fa",
    color: "#1e1e2e",
    fontSize: 10,
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
    fontSize: 11,
  },
  notifBtn: {
    background: "none",
    border: "1px solid #45475a",
    borderRadius: 4,
    color: "#a6adc8",
    fontSize: 12,
    width: 26,
    height: 22,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  notifBadge: {
    color: "#f38ba8",
    fontSize: 11,
    fontWeight: 700,
  },
};
