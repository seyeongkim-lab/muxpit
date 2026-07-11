import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWorkspaceStore, collectLeafIds, type Workspace } from "../stores/workspace";
import { useSshHostsStore, type SshHost } from "../stores/sshHosts";
import { useMonitorStore, type MonitorSnapshot } from "../stores/monitor";
import { useTmuxSessionsStore, type AttachInfo, type TmuxSession } from "../stores/tmuxSessions";
import { useWorkspaceInfoStore } from "../hooks/useWorkspaceInfo";
import { destroyAllTerminals } from "./terminalRegistry";
import { Sparkline } from "./Sparkline";
import { WindowControls } from "./WindowControls";
import type { SshConnection } from "../utils/sshConnection";
import { buildWorkspaceTabView } from "../utils/workspaceTabTitle";
import { computeSessionTabWidth } from "../utils/topBarLayout";

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
  filesRailVisible?: boolean;
  onToggleFilesRail?: () => void;
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

// "+" button (26px) plus the gap in front of it, reserved outside the
// tab-width calculation so the button always has room.
const NEW_SESSION_BUTTON_SPACE = 26 + 3;

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
  filesRailVisible,
  onToggleFilesRail,
}: TopDashboardBarProps) => {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeId = useWorkspaceStore((s) => s.activeId);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const reorderWorkspaces = useWorkspaceStore((s) => s.reorderWorkspaces);
  const sshHosts = useSshHostsStore((s) => s.hosts);
  const tmuxAttach = useTmuxSessionsStore((s) => s._attach);
  const tmuxByWs = useTmuxSessionsStore((s) => s.byWs);
  const [hoveredTab, setHoveredTab] = useState<TopTab | null>(null);
  const [pinnedTab, setPinnedTab] = useState<TopTab | null>(null);
  const visibleTab = pinnedTab ?? hoveredTab;
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const sessionTabsRowRef = useRef<HTMLDivElement>(null);
  const [sessionTabsRowWidth, setSessionTabsRowWidth] = useState(0);

  // Re-measure whenever the tab count changes (covers add/remove and async
  // session-restore hydration, where the row briefly renders with 0 tabs
  // before the real workspace list lands) and on window resize (covers the
  // maxWidth: min(58vw, ...) cap moving with viewport width).
  useEffect(() => {
    const el = sessionTabsRowRef.current;
    if (!el) return;
    setSessionTabsRowWidth(el.getBoundingClientRect().width);
  }, [workspaces.length]);

  useEffect(() => {
    const el = sessionTabsRowRef.current;
    if (!el) return;
    let frame = 0;
    const onResize = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setSessionTabsRowWidth(el.getBoundingClientRect().width);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const sessionTabWidth = computeSessionTabWidth(
    sessionTabsRowWidth - NEW_SESSION_BUTTON_SPACE,
    workspaces.length,
  );

  const endDrag = () => {
    setDragIndex(null);
    setOverIndex(null);
  };

  const dropOnTab = (targetIndex: number) => {
    if (dragIndex !== null && dragIndex !== targetIndex) {
      reorderWorkspaces(dragIndex, targetIndex);
    }
    endDrag();
  };

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
        <div
          ref={sessionTabsRowRef}
          style={styles.sessionTabsRow}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <div style={styles.sessionTabs}>
            {workspaces.map((workspace, index) => (
              <WorkspaceTab
                key={workspace.id}
                workspace={workspace}
                index={index}
                width={sessionTabWidth}
                isActive={workspace.id === activeId}
                isDragging={dragIndex === index}
                isDropTarget={overIndex === index && dragIndex !== null && dragIndex !== index}
                tmuxAttach={tmuxAttach[workspace.id]}
                tmuxSessions={tmuxByWs[workspace.id]?.sessions}
                onActivate={() => setActive(workspace.id)}
                onClose={(event) => closeWorkspace(event, workspace.id)}
                onDragStart={(event) => {
                  setDragIndex(index);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(event) => {
                  if (dragIndex === null) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (overIndex !== index) setOverIndex(index);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  dropOnTab(index);
                }}
                onDragEnd={endDrag}
              />
            ))}
          </div>
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
            onClick={onToggleFilesRail}
            style={{ ...styles.commandButton, ...(filesRailVisible ? styles.commandButtonActive : {}) }}
            title={filesRailVisible ? "Hide files rail" : "Show files rail"}
          >
            Files
          </button>
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
          <WindowControls
            onMinimize={onWindowMinimize}
            onMaximize={onWindowMaximize}
            onClose={onWindowClose}
          />
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
                    <span style={{ ...styles.hostDot, backgroundColor: host.color ?? "var(--wmux-accent)" }} />
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

const WorkspaceTab = ({
  workspace,
  index,
  width,
  isActive,
  isDragging,
  isDropTarget,
  tmuxAttach,
  tmuxSessions,
  onActivate,
  onClose,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  workspace: Workspace;
  index: number;
  width: number;
  isActive: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  tmuxAttach?: AttachInfo;
  tmuxSessions?: TmuxSession[];
  onActivate: () => void;
  onClose: (event: React.MouseEvent) => void;
  onDragStart: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDragOver: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDrop: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
}) => {
  // Subscribed per-workspace so an OSC7/title/gitBranch update on one
  // workspace only re-renders its own tab, not the whole tab bar.
  const info = useWorkspaceInfoStore((s) => s.info[workspace.id]);
  const tabView = buildWorkspaceTabView(workspace, info, tmuxAttach, tmuxSessions);
  const paneCount = tabView.paneCount;

  return (
    <button
      className={`wmux-btn wmux-top-tab${isActive ? " wmux-ws-active" : ""}`}
      onClick={onActivate}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={{
        ...styles.sessionTab,
        width,
        ...(isActive ? styles.sessionTabActive : {}),
        ...(isDragging ? styles.sessionTabDragging : {}),
        ...(isDropTarget ? styles.sessionTabDropTarget : {}),
      }}
      title={[
        tabView.title,
        workspace.name !== tabView.title ? workspace.name : null,
        tabView.detail,
        `${paneCount} pane${paneCount === 1 ? "" : "s"}`,
      ].filter(Boolean).join(" - ")}
    >
      <span style={styles.sessionIndex}>{index + 1}</span>
      {tabView.statusKind && (
        <span
          style={{
            ...styles.sessionStatusDot,
            ...(tabView.statusKind === "ready"
              ? styles.sessionStatusReady
              : styles.sessionStatusActive),
          }}
        />
      )}
      <span style={styles.sessionTabName}>{tabView.title}</span>
      {paneCount > 1 && <span style={styles.sessionPaneCount}>{paneCount}</span>}
      <span
        role="button"
        tabIndex={-1}
        onClick={onClose}
        style={styles.sessionClose}
        title="Close workspace"
      >
        x
      </span>
    </button>
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

  // With enough history the value slot shows a small CPU/MEM sparkline instead
  // of text; the numbers move into the button tooltip. MEM is drawn first so
  // the CPU line stays on top. Fixed width keeps the bar from shifting as data
  // arrives.
  const showGraph = !!monitor && (monitorSeries?.length ?? 0) >= 2;
  const value = showGraph ? (
    <Sparkline
      series={[
        { data: monitorSeries!.map((s) => s.memPercent), color: "var(--wmux-subtext)", fill: "none" },
        { data: monitorSeries!.map((s) => s.cpuPercent), color: "var(--wmux-accent)", fill: "none" },
      ]}
      width={56}
      height={16}
      style={{ width: 56, flexShrink: 0, display: "block" }}
    />
  ) : monitor ? (
    monitor.sshTarget
  ) : (
    "off"
  );
  const title = monitor && latestSnapshot
    ? `${monitor.sshTarget} — CPU ${Math.round(latestSnapshot.cpuPercent)}% · MEM ${formatMemoryMb(latestSnapshot.memUsedMb)} (${Math.round(latestSnapshot.memPercent)}%)`
    : monitor?.sshTarget;

  return (
    <TopTabButton
      active={active}
      label="Monitor"
      value={value}
      title={title}
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

const TopTabButton = ({
  active,
  label,
  value,
  title,
  onMouseEnter,
  onClick,
}: {
  active: boolean;
  label: string;
  value: React.ReactNode;
  title?: string;
  onMouseEnter: () => void;
  onClick: () => void;
}) => (
  <button
    className="wmux-btn wmux-top-tab"
    onMouseEnter={onMouseEnter}
    onClick={onClick}
    title={title}
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
    backgroundColor: "var(--wmux-titlebar-bg)",
  },
  bar: {
    height: 48,
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
  // Outer row: caps total width and keeps the "+" button outside the
  // clipped/shrinking tab strip so it's never cut off.
  sessionTabsRow: {
    minWidth: 0,
    // flex: 1 so this always stretches to the available width (capped by
    // maxWidth) regardless of how many/wide the tabs inside it currently
    // are — otherwise its measured width would depend on its own tabs'
    // widths, which depend on the measurement, and the two feed back into
    // each other until tabs collapse to the narrowest tier.
    flex: "1 1 auto",
    maxWidth: "min(58vw, 760px)",
    display: "flex",
    alignItems: "flex-end",
    gap: 3,
    height: "100%",
    padding: "8px 0 0",
  },
  // No scrollbar: an appearing/disappearing scrollbar shifted the whole bar.
  // Tabs shrink to fit instead (like Windows Terminal), so this never needs
  // to scroll.
  sessionTabs: {
    minWidth: 0,
    flex: "1 1 auto",
    display: "flex",
    alignItems: "flex-end",
    height: "100%",
    gap: 3,
    overflow: "hidden",
  },
  // Width is one of a few fixed steps (computeSessionTabWidth), not a
  // continuous flex-shrink value: title updates (OSC titles, cwd, AI status)
  // can't shift it, and it only changes tier when tab count / bar width
  // actually crosses a threshold.
  sessionTab: {
    height: 40,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 6,
    border: "none",
    borderRadius: "6px 6px 0 0",
    background: "transparent",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
    padding: "0 10px",
  },
  sessionTabActive: {
    background: "var(--wmux-bg-soft)",
    color: "var(--wmux-text)",
  },
  sessionTabDragging: {
    opacity: 0.4,
  },
  sessionTabDropTarget: {
    background: "var(--wmux-accent-soft)",
    borderColor: "var(--wmux-accent-strong)",
    borderBottomColor: "var(--wmux-accent-strong)",
  },
  sessionIndex: {
    color: "var(--wmux-subtext)",
    fontFamily: "var(--wmux-font-mono)",
    fontSize: 10,
    flexShrink: 0,
  },
  sessionStatusDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flexShrink: 0,
  },
  sessionStatusReady: {
    backgroundColor: "#3fb950",
    boxShadow: "0 0 0 1px rgba(63, 185, 80, 0.32)",
  },
  sessionStatusActive: {
    backgroundColor: "var(--wmux-accent)",
    boxShadow: "0 0 0 1px var(--wmux-accent-mid)",
  },
  sessionTabName: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 12,
    textAlign: "left",
  },
  sessionPaneCount: {
    color: "var(--wmux-subtext)",
    fontFamily: "var(--wmux-font-mono)",
    fontSize: 10,
    lineHeight: 1,
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
    width: 32,
    height: 40,
    border: "1px solid transparent",
    borderRadius: 4,
    background: "transparent",
    color: "var(--wmux-subtext)",
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
    height: "100%",
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
  // `background` (not backgroundColor): the base style uses the shorthand, and
  // React drops the property entirely when a merged style mixes shorthand and
  // longhand — the button then falls back to the UA's light button face.
  tabButtonActive: {
    borderColor: "var(--wmux-hairline-strong)",
    background: "var(--wmux-bg-elev)",
    color: "var(--wmux-text)",
  },
  // The button name carries the emphasis; the value/graph is auxiliary status.
  tabLabel: {
    fontSize: 12,
    color: "var(--wmux-text)",
  },
  tabValue: {
    maxWidth: 92,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--wmux-subtext)",
    fontFamily: "var(--wmux-font-mono)",
    fontSize: 11,
  },
  commandButton: {
    height: 24,
    border: "1px solid transparent",
    borderRadius: 4,
    background: "transparent",
    color: "var(--wmux-subtext)",
    cursor: "pointer",
    padding: "0 8px",
    fontSize: 12,
  },
  commandButtonActive: {
    borderColor: "var(--wmux-hairline-strong)",
    background: "var(--wmux-bg-elev)",
    color: "var(--wmux-text)",
  },
  popover: {
    position: "absolute",
    top: 48,
    right: 138,
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
    fontFamily: "var(--wmux-font-mono)",
    fontSize: 11,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  smallButton: {
    width: 22,
    height: 22,
    border: "1px solid transparent",
    borderRadius: 4,
    background: "transparent",
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
    padding: "7px 8px 7px 0",
  },
  metricLabel: {
    display: "block",
    color: "var(--wmux-subtext)",
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  metricValue: {
    display: "block",
    color: "var(--wmux-text)",
    fontSize: 14,
    fontFamily: "var(--wmux-font-mono)",
    marginTop: 3,
  },
  statusText: {
    color: "var(--wmux-subtext)",
    fontSize: 12,
    padding: 6,
  },
};
