import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWorkspaceStore, collectLeafIds } from "../stores/workspace";
import { useSshHostsStore, type SshHost } from "../stores/sshHosts";
import { useMonitorStore, type MonitorSnapshot } from "../stores/monitor";
import { destroyAllTerminals } from "./terminalRegistry";
import type { SshConnection } from "../utils/sshConnection";

interface SidebarMonitorInfo {
  monitorId: string;
  sshTarget: string;
  sshCommand: string;
  sshConnection?: SshConnection;
}

interface TopDashboardBarProps {
  onOpenSettings?: () => void;
  onOpenSshPanel?: () => void;
  onEditHost?: (hostId: string) => void;
  onConnectHost?: (host: SshHost) => void;
  monitor?: SidebarMonitorInfo | null;
  onCloseMonitor?: () => void;
  gridView?: boolean;
  onToggleGridView?: () => void;
}

type TopTab = "sessions" | "hosts" | "monitor";

interface MonitorDataEvent {
  monitor_id: string;
  cpu_percent: number;
  mem_total_mb: number;
  mem_used_mb: number;
  mem_percent: number;
  load_avg: [number, number, number];
  processes: {
    pid: number;
    user: string;
    cpu: number;
    mem: number;
    command: string;
  }[];
  hostname: string;
  timestamp: number;
  error: string | null;
  net: { rx_bytes_per_sec: number; tx_bytes_per_sec: number; link_speed_mbps: number | null } | null;
  disks: { mount: string; total_gb: number; used_gb: number; percent: number }[];
  claude_sessions: {
    project: string;
    project_path: string;
    session_id: string;
    started_at: string | null;
    last_activity: string | null;
    message_count: number;
  }[];
}

const formatMemoryMb = (mb: number): string => {
  if (mb < 1024) return `${Math.round(mb)}MB`;
  return `${(mb / 1024).toFixed(1)}GB`;
};

export const TopDashboardBar = ({
  onOpenSettings,
  onOpenSshPanel,
  onEditHost,
  onConnectHost,
  monitor,
  onCloseMonitor,
  gridView,
  onToggleGridView,
}: TopDashboardBarProps) => {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeId = useWorkspaceStore((s) => s.activeId);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const sshHosts = useSshHostsStore((s) => s.hosts);
  const monitorSeries = useMonitorStore((s) => monitor ? s.series[monitor.monitorId] : undefined);
  const latestSnapshot = monitorSeries?.[monitorSeries.length - 1] as MonitorSnapshot | undefined;
  const [hoveredTab, setHoveredTab] = useState<TopTab | null>(null);
  const [pinnedTab, setPinnedTab] = useState<TopTab | null>(null);
  const visibleTab = pinnedTab ?? hoveredTab;

  useEffect(() => {
    if (!monitor) return;
    let active = true;
    invoke("start_monitor", {
      monitorId: monitor.monitorId,
      sshCommand: monitor.sshCommand,
      sshConnection: monitor.sshConnection ?? null,
    }).catch((err) => {
      if (active) console.error("start_monitor error:", err);
    });

    return () => {
      active = false;
      invoke("stop_monitor", { monitorId: monitor.monitorId }).catch(() => {});
      useMonitorStore.getState().clearMonitor(monitor.monitorId);
    };
  }, [monitor]);

  useEffect(() => {
    if (!monitor) return;
    const monitorId = monitor.monitorId;
    const unlisten = listen<MonitorDataEvent>("monitor-data", (event) => {
      const d = event.payload;
      if (d.monitor_id !== monitorId) return;

      useMonitorStore.getState().pushSnapshot(monitorId, {
        cpuPercent: d.cpu_percent,
        memTotalMb: d.mem_total_mb,
        memUsedMb: d.mem_used_mb,
        memPercent: d.mem_percent,
        loadAvg: d.load_avg,
        processes: d.processes.map((process) => ({
          pid: process.pid,
          user: process.user,
          cpu: process.cpu,
          mem: process.mem,
          command: process.command,
        })),
        hostname: d.hostname,
        timestamp: d.timestamp,
        error: d.error,
        net: d.net
          ? {
              rxBytesPerSec: d.net.rx_bytes_per_sec,
              txBytesPerSec: d.net.tx_bytes_per_sec,
              linkSpeedMbps: d.net.link_speed_mbps,
            }
          : null,
        disks: (d.disks ?? []).map((disk) => ({
          mount: disk.mount,
          totalGb: disk.total_gb,
          usedGb: disk.used_gb,
          percent: disk.percent,
        })),
        claudeSessions: (d.claude_sessions ?? []).map((session) => ({
          project: session.project,
          projectPath: session.project_path,
          sessionId: session.session_id,
          startedAt: session.started_at,
          lastActivity: session.last_activity,
          messageCount: session.message_count,
        })),
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [monitor]);

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeId);
  const monitorSummary = useMemo(() => {
    if (!monitor) return "off";
    if (!latestSnapshot) return monitor.sshTarget;
    const cpu = Number.isFinite(latestSnapshot.cpuPercent)
      ? `${Math.round(latestSnapshot.cpuPercent)}%`
      : "--";
    return `${cpu} ${formatMemoryMb(latestSnapshot.memUsedMb)}`;
  }, [latestSnapshot, monitor]);

  const closeWorkspace = (event: React.MouseEvent, id: string) => {
    event.stopPropagation();
    const workspace = workspaces.find((item) => item.id === id);
    if (workspace) destroyAllTerminals(collectLeafIds(workspace.layout));
    removeWorkspace(id);
  };

  const showTab = (tab: TopTab) => {
    if (!pinnedTab) setHoveredTab(tab);
  };

  const hideTab = () => {
    if (!pinnedTab) setHoveredTab(null);
  };

  const togglePinned = (tab: TopTab) => {
    setPinnedTab((current) => current === tab ? null : tab);
    setHoveredTab(null);
  };

  return (
    <div style={styles.wrapper} onMouseLeave={hideTab}>
      <div style={styles.bar}>
        <div style={styles.brandGroup}>
          <span className="wmux-logo" style={styles.logo}>wmux</span>
          <span style={styles.activeName} title={activeWorkspace?.name}>
            {activeWorkspace?.name ?? "Terminal"}
          </span>
        </div>
        <div style={styles.tabs}>
          <button
            className="wmux-btn"
            onClick={() => addWorkspace()}
            style={styles.iconButton}
            title="New workspace"
          >
            +
          </button>
          <TopTabButton
            active={visibleTab === "sessions"}
            label="Sessions"
            value={String(workspaces.length)}
            onMouseEnter={() => showTab("sessions")}
            onClick={() => togglePinned("sessions")}
          />
          <TopTabButton
            active={visibleTab === "hosts"}
            label="Hosts"
            value={String(sshHosts.length)}
            onMouseEnter={() => showTab("hosts")}
            onClick={() => togglePinned("hosts")}
          />
          <TopTabButton
            active={visibleTab === "monitor"}
            label="Monitor"
            value={monitorSummary}
            onMouseEnter={() => showTab("monitor")}
            onClick={() => togglePinned("monitor")}
          />
          <button
            className="wmux-btn"
            onClick={onToggleGridView}
            style={{ ...styles.commandButton, ...(gridView ? styles.commandButtonActive : {}) }}
            title="Grid overview"
          >
            Grid
          </button>
          <button
            className="wmux-btn"
            onClick={onOpenSettings}
            style={styles.commandButton}
            title="Settings"
          >
            Settings
          </button>
        </div>
      </div>
      {visibleTab && (
        <div
          style={styles.popover}
          onMouseEnter={() => setHoveredTab(visibleTab)}
          onMouseLeave={hideTab}
        >
          {visibleTab === "sessions" && (
            <div style={styles.popoverList}>
              {workspaces.map((workspace, index) => {
                const isActive = workspace.id === activeId;
                const paneCount = collectLeafIds(workspace.layout).length;
                return (
                  <div
                    key={workspace.id}
                    className={`wmux-ws-item${isActive ? " wmux-ws-active" : ""}`}
                    style={{ ...styles.sessionRow, ...(isActive ? styles.sessionRowActive : {}) }}
                    onClick={() => setActive(workspace.id)}
                  >
                    <span style={styles.index}>{index + 1}</span>
                    <span style={styles.sessionName}>{workspace.name}</span>
                    <span style={styles.metaText}>{paneCount} panes</span>
                    <button
                      className="wmux-btn"
                      onClick={(event) => closeWorkspace(event, workspace.id)}
                      style={styles.closeBtn}
                      title="Close workspace"
                    >
                      x
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {visibleTab === "hosts" && (
            <div style={styles.popoverList}>
              <div style={styles.popoverHeader}>
                <span className="wmux-section-label">HOSTS</span>
                <button className="wmux-btn" onClick={onOpenSshPanel} style={styles.smallButton}>
                  +
                </button>
              </div>
              {sshHosts.length === 0 && (
                <button className="wmux-btn" onClick={onOpenSshPanel} style={styles.emptyButton}>
                  Add host
                </button>
              )}
              {sshHosts.map((host) => {
                const target = `${host.user}@${host.host}${host.port !== 22 ? `:${host.port}` : ""}`;
                return (
                  <div key={host.id} style={styles.hostRow} onClick={() => onConnectHost?.(host)}>
                    <span style={{ ...styles.hostDot, backgroundColor: host.color ?? "#89b4fa" }} />
                    <span style={styles.hostName}>{host.name}</span>
                    <span style={styles.hostTarget}>{target}</span>
                    <button
                      className="wmux-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        onEditHost?.(host.id);
                      }}
                      style={styles.closeBtn}
                      title="Edit host"
                    >
                      e
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {visibleTab === "monitor" && (
            <div style={styles.monitorPanel}>
              {!monitor && <div style={styles.statusText}>No SSH monitor</div>}
              {monitor && (
                <>
                  <div style={styles.monitorTop}>
                    <div>
                      <span className="wmux-section-label">MONITOR</span>
                      <div style={styles.monitorTarget}>{monitor.sshTarget}</div>
                    </div>
                    {onCloseMonitor && (
                      <button className="wmux-btn" onClick={onCloseMonitor} style={styles.smallButton}>
                        x
                      </button>
                    )}
                  </div>
                  {latestSnapshot ? (
                    <div style={styles.monitorGrid}>
                      <Metric label="CPU" value={`${Math.round(latestSnapshot.cpuPercent)}%`} />
                      <Metric label="MEM" value={formatMemoryMb(latestSnapshot.memUsedMb)} />
                      <Metric label="LOAD" value={latestSnapshot.loadAvg?.[0]?.toFixed(2) ?? "--"} />
                    </div>
                  ) : (
                    <div style={styles.statusText}>waiting for data</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const TopTabButton = ({
  active,
  label,
  value,
  onMouseEnter,
  onClick,
}: {
  active: boolean;
  label: string;
  value: string;
  onMouseEnter: () => void;
  onClick: () => void;
}) => (
  <button
    className="wmux-btn"
    onMouseEnter={onMouseEnter}
    onClick={onClick}
    style={{ ...styles.tabButton, ...(active ? styles.tabButtonActive : {}) }}
  >
    <span style={styles.tabLabel}>{label}</span>
    <span style={styles.tabValue}>{value}</span>
  </button>
);

const Metric = ({ label, value }: { label: string; value: string }) => (
  <div style={styles.metric}>
    <span style={styles.metricLabel}>{label}</span>
    <span style={styles.metricValue}>{value}</span>
  </div>
);

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: "relative",
    zIndex: 20,
    backgroundColor: "var(--wmux-bg)",
    borderBottom: "1px solid var(--wmux-hairline)",
  },
  bar: {
    height: 34,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "0 10px 0 12px",
  },
  brandGroup: {
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: 9,
  },
  logo: {
    fontSize: 13,
  },
  activeName: {
    minWidth: 0,
    color: "var(--wmux-subtext)",
    fontSize: 12,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  tabs: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    minWidth: 0,
  },
  iconButton: {
    width: 26,
    height: 24,
    border: "1px solid var(--wmux-hairline)",
    borderRadius: 4,
    background: "var(--wmux-bg-elev)",
    color: "var(--wmux-text)",
    cursor: "pointer",
    padding: 0,
    lineHeight: 1,
  },
  tabButton: {
    height: 24,
    display: "flex",
    alignItems: "center",
    gap: 7,
    border: "1px solid transparent",
    borderRadius: 4,
    background: "transparent",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
    padding: "0 8px",
  },
  tabButtonActive: {
    borderColor: "var(--wmux-hairline-strong)",
    backgroundColor: "var(--wmux-bg-elev)",
    color: "var(--wmux-text)",
  },
  tabLabel: {
    fontSize: 12,
  },
  tabValue: {
    maxWidth: 92,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--wmux-accent)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
  },
  commandButton: {
    height: 24,
    border: "1px solid var(--wmux-hairline)",
    borderRadius: 4,
    background: "var(--wmux-bg-elev)",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
    padding: "0 8px",
    fontSize: 12,
  },
  commandButtonActive: {
    borderColor: "var(--wmux-accent)",
    color: "var(--wmux-text)",
  },
  popover: {
    position: "absolute",
    top: 34,
    right: 10,
    width: 360,
    maxHeight: "min(440px, 70vh)",
    overflow: "auto",
    backgroundColor: "var(--wmux-bg)",
    border: "1px solid var(--wmux-hairline-strong)",
    borderRadius: 6,
    boxShadow: "0 12px 32px rgba(0, 0, 0, 0.34)",
  },
  popoverList: {
    display: "flex",
    flexDirection: "column",
    padding: "6px 0",
  },
  popoverHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "4px 10px 7px",
  },
  sessionRow: {
    minHeight: 30,
    display: "grid",
    gridTemplateColumns: "24px minmax(0, 1fr) 58px 24px",
    alignItems: "center",
    gap: 8,
    padding: "4px 8px 4px 10px",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
  },
  sessionRowActive: {
    backgroundColor: "var(--wmux-accent-soft)",
    color: "var(--wmux-text)",
  },
  index: {
    color: "var(--wmux-subtext)",
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
  },
  sessionName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 13,
  },
  metaText: {
    color: "var(--wmux-subtext)",
    fontSize: 11,
    textAlign: "right",
  },
  closeBtn: {
    border: "none",
    background: "transparent",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
    padding: 0,
    width: 22,
    height: 22,
    borderRadius: 3,
  },
  hostRow: {
    minHeight: 30,
    display: "grid",
    gridTemplateColumns: "10px minmax(68px, auto) minmax(0, 1fr) 24px",
    alignItems: "center",
    gap: 8,
    padding: "4px 8px 4px 10px",
    cursor: "pointer",
  },
  hostDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
  },
  hostName: {
    color: "var(--wmux-text)",
    fontSize: 13,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  hostTarget: {
    color: "var(--wmux-subtext)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  smallButton: {
    width: 22,
    height: 22,
    border: "1px solid var(--wmux-hairline)",
    borderRadius: 4,
    background: "var(--wmux-bg-elev)",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
    padding: 0,
  },
  emptyButton: {
    margin: "6px 10px",
    height: 30,
    border: "1px solid var(--wmux-hairline)",
    borderRadius: 4,
    background: "var(--wmux-bg-elev)",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
  },
  monitorPanel: {
    padding: 10,
  },
  monitorTop: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 10,
  },
  monitorTarget: {
    color: "var(--wmux-text)",
    fontSize: 13,
    marginTop: 4,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  monitorGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 8,
  },
  metric: {
    border: "1px solid var(--wmux-hairline)",
    borderRadius: 4,
    background: "var(--wmux-bg-elev)",
    padding: "7px 8px",
  },
  metricLabel: {
    display: "block",
    color: "var(--wmux-subtext)",
    fontSize: 10,
    fontFamily: "'JetBrains Mono', monospace",
  },
  metricValue: {
    display: "block",
    color: "var(--wmux-text)",
    fontSize: 14,
    fontFamily: "'JetBrains Mono', monospace",
    marginTop: 3,
  },
  statusText: {
    color: "var(--wmux-subtext)",
    fontSize: 12,
    padding: 6,
  },
};
