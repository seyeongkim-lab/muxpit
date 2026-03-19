import { useNotificationStore } from "../stores/notifications";

export const NotificationPanel = () => {
  const { notifications, panelOpen, setPanel, clearAll } =
    useNotificationStore();

  if (!panelOpen) return null;

  return (
    <div style={styles.overlay} onClick={() => setPanel(false)}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Notifications</span>
          <div style={styles.actions}>
            {notifications.length > 0 && (
              <button onClick={clearAll} style={styles.clearBtn}>
                Clear all
              </button>
            )}
            <button onClick={() => setPanel(false)} style={styles.closeBtn}>
              x
            </button>
          </div>
        </div>

        <div style={styles.list}>
          {notifications.length === 0 ? (
            <div style={styles.empty}>No notifications</div>
          ) : (
            notifications.map((n) => (
              <div
                key={n.id}
                style={{
                  ...styles.item,
                  ...(n.read ? {} : styles.itemUnread),
                }}
              >
                <div style={styles.itemTitle}>{n.title}</div>
                <div style={styles.itemBody}>{n.body}</div>
                <div style={styles.itemTime}>
                  {new Date(n.timestamp).toLocaleTimeString()}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
    zIndex: 100,
    display: "flex",
    justifyContent: "flex-end",
  },
  panel: {
    width: 360,
    height: "100%",
    backgroundColor: "#181825",
    borderLeft: "1px solid #313244",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #313244",
  },
  title: {
    color: "#cdd6f4",
    fontSize: 14,
    fontWeight: 600,
  },
  actions: {
    display: "flex",
    gap: 8,
    alignItems: "center",
  },
  clearBtn: {
    background: "none",
    border: "1px solid #45475a",
    borderRadius: 4,
    color: "#a6adc8",
    fontSize: 11,
    padding: "3px 8px",
    cursor: "pointer",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#a6adc8",
    fontSize: 16,
    cursor: "pointer",
    padding: "2px 6px",
  },
  list: {
    flex: 1,
    overflowY: "auto",
    padding: 8,
  },
  empty: {
    color: "#585b70",
    fontSize: 13,
    textAlign: "center" as const,
    padding: 24,
  },
  item: {
    padding: "10px 12px",
    borderRadius: 6,
    marginBottom: 6,
    backgroundColor: "#1e1e2e",
  },
  itemUnread: {
    borderLeft: "3px solid #89b4fa",
  },
  itemTitle: {
    color: "#cdd6f4",
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 2,
  },
  itemBody: {
    color: "#a6adc8",
    fontSize: 12,
    marginBottom: 4,
  },
  itemTime: {
    color: "#585b70",
    fontSize: 10,
  },
};
