import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWorkspaceStore, collectLeafIds } from "../stores/workspace";
import { useSshHostsStore, type SshHost } from "../stores/sshHosts";
import { useMonitorStore, type MonitorSnapshot } from "../stores/monitor";
import { useTmuxSessionsStore } from "../stores/tmuxSessions";
import { useWorkspaceInfoStore } from "../hooks/useWorkspaceInfo";
import { destroyAllTerminals } from "./terminalRegistry";
import type { SshConnection } from "../utils/sshConnection";
import { buildWorkspaceTabView } from "../utils/workspaceTabTitle";

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
  onWindowMinimize?: () => void;
  onWindowMaximize?: () => void;
  onWindowClose?: () => void;
  gridView?: boolean;
  onToggleGridView?: () => void;
}

type TopTab = "hosts" | "monitor";

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
  onWindowMinimize,
  onWindowMaximize,
  onWindowClose,
  gridView,
  onToggleGridView,
}: TopDashboardBarProps) => {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeId = useWorkspaceStore((s) => s.activeId);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const sshHosts = useSshHostsStore((s) => s.hosts);
  const infoMap = useWorkspaceInfoStore((s) => s.info);
  const tmuxAttach = useTmuxSessionsStore((s) => s._attach);
  const tmuxByWs = useTmuxSessionsStore((s) => s.byWs);
  const [hoveredTab, setHoveredTab] = useState<TopTab | null>(null);
  const [pinnedTab, setPinnedTab] = useState<TopTab | null>(null);
  const visibleTab = pinnedTab ?? hoveredTab;

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
      <MonitorLifecycle monitor={monitor} />
      <div data-tauri-drag-region style={styles.bar} onDoubleClick={onWindowMaximize}>
        <div data-tauri-drag-region style={styles.brandGroup}>
          <span className="wmux-logo" style={styles.logo}>wmux</span>
        </div>
        <div style={styles.sessionTabs} onDoubleClick={(event) => event.stopPropagation()}>
          {workspaces.map((workspace, index) => {
            const isActive = workspace.id === activeId;
            const tabView = buildWorkspaceTabView(
              workspace,
              infoMap[workspace.id],
              tmuxAttach[workspace.id],
              tmuxByWs[workspace.id]?.sessions,
            );
            const paneCount = tabView.paneCount;
            return (
              <button
                key={workspace.id}
                className={`wmux-btn wmux-top-tab${isActive ? " wmux-ws-active" : ""}`}
                onClick={() => setActive(workspace.id)}
                style={{ ...styles.sessionTab, ...(isActive ? styles.sessionTabActive : {}) }}
                title={[
                  tabView.title,
                  workspace.name !== tabView.title ? workspace.name : null,
                  tabView.detail,
                  `${paneCount} pane${paneCount === 1 ? "" : "s"}`,
                ].filter(Boolean).join(" - ")}
              >
                <span style={styles.sessionIndex}>{index + 1}</span>
                <span style={styles.sessionTabName}>{tabView.title}</span>
                {paneCount > 1 && <span style={styles.sessionPaneCount}>{paneCount}</span>}
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(event) => closeWorkspace(event, workspace.id)}
                  style={styles.sessionClose}
                  title="Close workspace"
                >
                  x
                </span>
              </button>
            );
          })}
          <button
            className="wmux-btn"
            onClick={() => addWorkspace()}
            style={styles.newSessionButton}
            title="New workspace"
          >
            +
          </button>
        </div>
        <div data-tauri-drag-region style={styles.dragSpacer} />
        <div style={styles.controls} onDoubleClick={(event) => event.stopPropagation()}>
          <TopTabButton
            active={visibleTab === "hosts"}
            label="Hosts"
            value={String(sshHosts.length)}
            onMouseEnter={() => showTab("hosts")}
            onClick={() => togglePinned("hosts")}
          />
          <MonitorTabButton
            monitor={monitor}
            active={visibleTab === "monitor"}
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
          <div style={styles.windowControls}>
            <button
              type="button"
              className="wmux-titlebar-btn"
              style={styles.windowButton}
              onClick={onWindowMinimize}
              title="Minimize"
            >
              -
            </button>
            <button
              type="button"
              className="wmux-titlebar-btn"
              style={styles.windowButton}
              onClick={onWindowMaximize}
              title="Maximize"
            >
              □
            </button>
            <button
              type="button"
              className="wmux-titlebar-btn wmux-titlebar-close"
              style={{ ...styles.windowButton, ...styles.windowCloseButton }}
              onClick={onWindowClose}
              title="Close"
            >
              ×
            </button>
          </div>
        </div>
      </div>
      {visibleTab && (
        <div
          style={styles.popover}
          onMouseEnter={() => setHoveredTab(visibleTab)}
          onMouseLeave={hideTab}
        >
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
            <MonitorPopover monitor={monitor} onCloseMonitor={onCloseMonitor} />
          )}
        </div>
      )}
    </div>
  );
};

const MonitorLifecycle = ({ monitor }: { monitor?: SidebarMonitorInfo | null }) => {
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

  return null;
};

const MonitorTabButton = ({
  monitor,
  active,
  onMouseEnter,
  onClick,
}: {
  monitor?: SidebarMonitorInfo | null;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) => {
  const monitorSeries = useMonitorStore((s) => monitor ? s.series[monitor.monitorId] : undefined);
  const latestSnapshot = monitorSeries?.[monitorSeries.length - 1] as MonitorSnapshot | undefined;
  const value = monitorSummary(monitor, latestSnapshot);

  return (
    <TopTabButton
      active={active}
      label="Monitor"
      value={value}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
    />
  );
};

const MonitorPopover = ({
  monitor,
  onCloseMonitor,
}: {
  monitor?: SidebarMonitorInfo | null;
  onCloseMonitor?: () => void;
}) => {
  const monitorSeries = useMonitorStore((s) => monitor ? s.series[monitor.monitorId] : undefined);
  const latestSnapshot = monitorSeries?.[monitorSeries.length - 1] as MonitorSnapshot | undefined;

  return (
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
  );
};

const monitorSummary = (
  monitor: SidebarMonitorInfo | null | undefined,
  latestSnapshot: MonitorSnapshot | undefined,
): string => {
  if (!monitor) return "off";
  if (!latestSnapshot) return monitor.sshTarget;
  const cpu = Number.isFinite(latestSnapshot.cpuPercent)
    ? `${Math.round(latestSnapshot.cpuPercent)}%`
    : "--";
  return `${cpu} ${formatMemoryMb(latestSnapshot.memUsedMb)}`;
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
    className="wmux-btn wmux-top-tab"
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
    gap: 8,
    padding: "0 0 0 12px",
    color: "var(--wmux-text)",
    userSelect: "none",
  },
  brandGroup: {
    minWidth: 0,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    width: 54,
  },
  logo: {
    fontSize: 13,
  },
  sessionTabs: {
    minWidth: 0,
    maxWidth: "min(58vw, 760px)",
    display: "flex",
    alignItems: "center",
    gap: 3,
    overflowX: "auto",
    overflowY: "hidden",
    padding: "3px 0 0",
  },
  sessionTab: {
    height: 29,
    minWidth: 112,
    maxWidth: 220,
    display: "flex",
    alignItems: "center",
    gap: 6,
    border: "1px solid transparent",
    borderBottomColor: "transparent",
    borderRadius: "5px 5px 0 0",
    background: "transparent",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
    padding: "0 7px",
    flexShrink: 0,
  },
  sessionTabActive: {
    background: "var(--wmux-bg-elev)",
    borderColor: "var(--wmux-hairline-strong)",
    borderBottomColor: "var(--wmux-bg-elev)",
    color: "var(--wmux-text)",
  },
  sessionIndex: {
    color: "var(--wmux-accent)",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    flexShrink: 0,
  },
  sessionTabName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 12,
  },
  sessionPaneCount: {
    color: "var(--wmux-subtext)",
    border: "1px solid var(--wmux-hairline)",
    borderRadius: 8,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9,
    lineHeight: "13px",
    minWidth: 14,
    height: 14,
    textAlign: "center",
    flexShrink: 0,
  },
  sessionClose: {
    color: "var(--wmux-subtext)",
    fontSize: 11,
    lineHeight: "16px",
    width: 16,
    height: 16,
    borderRadius: 3,
    textAlign: "center",
    flexShrink: 0,
  },
  newSessionButton: {
    width: 26,
    height: 26,
    border: "1px solid var(--wmux-hairline)",
    borderRadius: 4,
    background: "var(--wmux-bg-elev)",
    color: "var(--wmux-text)",
    cursor: "pointer",
    padding: 0,
    lineHeight: 1,
    flexShrink: 0,
  },
  dragSpacer: {
    minWidth: 18,
    flex: 1,
    height: "100%",
  },
  controls: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
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
    right: 132,
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
  windowControls: {
    height: 34,
    display: "flex",
    marginLeft: 3,
  },
  windowButton: {
    width: 42,
    height: "100%",
    border: "none",
    borderLeft: "1px solid transparent",
    backgroundColor: "transparent",
    color: "var(--wmux-subtext)",
    fontSize: 13,
    lineHeight: 1,
    cursor: "default",
  },
  windowCloseButton: {
    fontSize: 16,
  },
};
