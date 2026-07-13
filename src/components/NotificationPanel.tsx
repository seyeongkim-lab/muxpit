import { useNotificationStore } from "../stores/notifications";
import { useAgentTaskStore } from "../stores/agentTasks";
import { useWorkspaceStore } from "../stores/workspace";
import {
  resolveAgentTaskTarget,
  type AgentTask,
  type AgentTaskStatus,
} from "../utils/agentTask";

const statusColor: Record<AgentTaskStatus, string> = {
  working: "#89b4fa",
  waiting: "#f9e2af",
  done: "#a6e3a1",
  error: "#f38ba8",
};

export const NotificationPanel = () => {
  const { notifications, panelOpen, setPanel, clearAll } =
    useNotificationStore();
  const tasks = useAgentTaskStore((state) => state.tasks);
  const acknowledge = useAgentTaskStore((state) => state.acknowledge);
  const clearTasks = useAgentTaskStore((state) => state.clearTasks);

  if (!panelOpen) return null;

  return (
    <div style={styles.overlay} onClick={() => setPanel(false)}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Agent inbox</span>
          <div style={styles.actions}>
            {(tasks.length > 0 || notifications.length > 0) && (
              <button onClick={() => { clearTasks(); clearAll(); }} style={styles.clearBtn}>
                Clear all
              </button>
            )}
            <button onClick={() => setPanel(false)} style={styles.closeBtn}>
              x
            </button>
          </div>
        </div>

        <div style={styles.list}>
          {tasks.length === 0 && notifications.length === 0 ? (
            <div style={styles.empty}>No agent tasks</div>
          ) : (
            <>
              {tasks.map((task) => (
                <button
                  key={task.id}
                  onClick={() => jumpToTask(task, acknowledge, () => setPanel(false))}
                  style={{
                    ...styles.item,
                    ...styles.taskButton,
                    borderLeft: `3px solid ${statusColor[task.status]}`,
                    opacity: task.acknowledged ? 0.65 : 1,
                  }}
                >
                  <div style={styles.itemRow}>
                    <span style={styles.itemTitle}>{task.source}</span>
                    <span style={{ ...styles.status, color: statusColor[task.status] }}>
                      {task.status}
                    </span>
                  </div>
                  <div style={styles.itemBody}>{task.label}</div>
                  <div style={styles.itemTime}>{new Date(task.updatedAt).toLocaleTimeString()}</div>
                </button>
              ))}
              {notifications.map((n) => (
                <div
                  key={n.id}
                  style={{
                    ...styles.item,
                    ...(n.read ? {} : styles.itemUnread),
                  }}
                >
                  <div style={styles.itemTitle}>{n.title}</div>
                  <div style={styles.itemBody}>{n.body}</div>
                  <div style={styles.itemTime}>{new Date(n.timestamp).toLocaleTimeString()}</div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const jumpToTask = (
  task: AgentTask,
  acknowledge: (id: string) => void,
  close: () => void,
) => {
  const store = useWorkspaceStore.getState();
  const target = resolveAgentTaskTarget(task, store.workspaces);
  if (!target) return;
  store.setActive(target.workspaceId);
  store.setFocusedLeaf(target.workspaceId, target.surfaceId);
  acknowledge(task.id);
  close();
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
  taskButton: {
    width: "100%",
    border: "none",
    textAlign: "left",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  itemRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 2,
  },
  status: {
    fontSize: 10,
    textTransform: "uppercase",
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
