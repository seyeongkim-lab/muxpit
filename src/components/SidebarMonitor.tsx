import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMonitorStore, type MonitorSnapshot } from "../stores/monitor";
import { useSidebarLayoutStore } from "../stores/sidebarLayout";
import type { SshConnection } from "../utils/sshConnection";
import { Sparkline } from "./Sparkline";

interface SidebarMonitorProps {
  monitorId: string;
  sshTarget: string;
  sshCommand: string;
  sshConnection?: SshConnection;
  onClose: () => void;
}

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

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${bytes} B/s`;
};

const ProgressBar = ({ value, color, label }: { value: number; color: string; label: string }) => (
  <div style={styles.barRow}>
    <span style={styles.barLabel}>{label}</span>
    <div style={styles.barTrack}>
      <div style={{ ...styles.barFill, width: `${Math.min(100, value)}%`, backgroundColor: color }} />
    </div>
    <span style={{ ...styles.barValue, color }}>{value.toFixed(1)}%</span>
  </div>
);

const EMPTY_SERIES: MonitorSnapshot[] = [];

export const SidebarMonitor = ({ monitorId, sshTarget, sshCommand, sshConnection, onClose }: SidebarMonitorProps) => {
  const series = useMonitorStore((s) => s.series[monitorId]) ?? EMPTY_SERIES;
  const latest = series[series.length - 1] as MonitorSnapshot | undefined;

  // Start monitor on mount; re-start when monitorId changes
  useEffect(() => {
    let active = true;
    invoke("start_monitor", { monitorId, sshCommand, sshConnection: sshConnection ?? null }).catch((err) => {
      if (active) console.error("start_monitor error:", err);
    });

    return () => {
      active = false;
      invoke("stop_monitor", { monitorId }).catch(() => {});
      useMonitorStore.getState().clearMonitor(monitorId);
    };
  }, [monitorId, sshCommand, sshConnection]);

  // Listen for monitor-data events
  useEffect(() => {
    const unlisten = listen<MonitorDataEvent>("monitor-data", (event) => {
      const d = event.payload;
      if (d.monitor_id !== monitorId) return;

      const snapshot: MonitorSnapshot = {
        cpuPercent: d.cpu_percent,
        memTotalMb: d.mem_total_mb,
        memUsedMb: d.mem_used_mb,
        memPercent: d.mem_percent,
        loadAvg: d.load_avg,
        processes: d.processes.map((p) => ({
          pid: p.pid,
          user: p.user,
          cpu: p.cpu,
          mem: p.mem,
          command: p.command,
        })),
        hostname: d.hostname,
        timestamp: d.timestamp,
        error: d.error,
        net: d.net ? { rxBytesPerSec: d.net.rx_bytes_per_sec, txBytesPerSec: d.net.tx_bytes_per_sec, linkSpeedMbps: d.net.link_speed_mbps } : null,
        disks: (d.disks ?? []).map((dk) => ({ mount: dk.mount, totalGb: dk.total_gb, usedGb: dk.used_gb, percent: dk.percent })),
        claudeSessions: (d.claude_sessions ?? []).map((cs: { project: string; project_path: string; session_id: string; started_at: string | null; last_activity: string | null; message_count: number }) => ({
          project: cs.project,
          projectPath: cs.project_path,
          sessionId: cs.session_id,
          startedAt: cs.started_at,
          lastActivity: cs.last_activity,
          messageCount: cs.message_count,
        })),
      };

      useMonitorStore.getState().pushSnapshot(monitorId, snapshot);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [monitorId]);

  const error = latest?.error;
  const cpuData = series.map((s) => s.cpuPercent);
  const memData = series.map((s) => s.memPercent);
  const rxData = series.map((s) => s.net?.rxBytesPerSec ?? 0);
  const txData = series.map((s) => s.net?.txBytesPerSec ?? 0);

  const height = useSidebarLayoutStore((s) => s.monitorHeight);
  const setHeight = useSidebarLayoutStore((s) => s.setMonitorHeight);

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

  return (
    <div className="wmux-card" style={{ ...styles.container, height }}>
      <div style={styles.resizeHandle} onMouseDown={onResizeStart} title="Drag to resize" />
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.hostname}>{latest?.hostname || sshTarget}</span>
        <button className="wmux-btn" onClick={onClose} style={styles.closeBtn} title="Close monitor">x</button>
      </div>

      {error ? (
        <div style={styles.error}>{error}</div>
      ) : !latest ? (
        <div style={styles.loading}>connecting...</div>
      ) : (
        <>
          {/* CPU/MEM bars */}
          <div style={styles.bars}>
            <ProgressBar value={latest.cpuPercent} color={COLORS.blue} label="CPU" />
            <ProgressBar value={latest.memPercent} color={COLORS.green} label="MEM" />
          </div>

          {/* Sparklines */}
          <div style={styles.sparklines}>
            <Sparkline series={[{ data: cpuData, color: COLORS.blue }]} height={32} />
            <Sparkline series={[{ data: memData, color: COLORS.green }]} height={32} />
          </div>

          {/* Network */}
          {latest.net && (() => {
            const speedMbps = latest.net.linkSpeedMbps;
            // Convert link speed (Mbps) to bytes/sec for graph max
            const speedBytesPerSec = speedMbps ? (speedMbps * 1000 * 1000) / 8 : undefined;
            const formatSpeed = (mbps: number) => mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`;
            return (
              <div style={styles.netSection}>
                <div style={styles.netRow}>
                  <span style={{ color: COLORS.teal, fontSize: 12 }}>
                    NET{speedMbps ? ` (${formatSpeed(speedMbps)})` : ""}
                  </span>
                  <span style={{ color: COLORS.subtext, fontSize: 11 }}>
                    {"▼ "}{formatBytes(latest.net.rxBytesPerSec)}{"  ▲ "}{formatBytes(latest.net.txBytesPerSec)}
                  </span>
                </div>
                <Sparkline series={[{ data: rxData, color: COLORS.teal }]} height={24} fixedMax={speedBytesPerSec} autoMax={!speedBytesPerSec} />
                <Sparkline series={[{ data: txData, color: COLORS.yellow }]} height={24} fixedMax={speedBytesPerSec} autoMax={!speedBytesPerSec} />
              </div>
            );
          })()}

          {/* Load average */}
          <div style={styles.loadRow}>
            <span style={styles.loadLabel}>Load</span>
            <span style={styles.loadValues}>
              {latest.loadAvg.map((v) => v.toFixed(2)).join("  ")}
            </span>
          </div>

          {/* Disk usage */}
          {latest.disks.length > 0 && (
            <div style={styles.diskSection}>
              {latest.disks.map((dk) => (
                <div key={dk.mount} style={styles.diskRow}>
                  <span style={styles.diskMount}>{dk.mount}</span>
                  <div style={styles.diskBarTrack}>
                    <div style={{
                      ...styles.diskBarFill,
                      width: `${Math.min(100, dk.percent)}%`,
                      backgroundColor: dk.percent > 90 ? COLORS.red : dk.percent > 70 ? COLORS.yellow : COLORS.mauve,
                    }} />
                  </div>
                  <span style={styles.diskLabel}>
                    {dk.usedGb.toFixed(0)}/{dk.totalGb.toFixed(0)}G
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Compact process list (top 5) */}
          <div style={styles.processes}>
            <div style={styles.procHeader}>
              <span style={{ width: 38 }}>CPU%</span>
              <span style={{ flex: 1 }}>CMD</span>
            </div>
            {latest.processes.slice(0, 5).map((p) => (
              <div key={p.pid} style={styles.procRow}>
                <span style={{ width: 38, color: p.cpu > 50 ? COLORS.red : COLORS.subtext }}>
                  {p.cpu.toFixed(1)}
                </span>
                <span style={styles.procCmd}>{p.command}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
    overflow: "auto",
    flexShrink: 0,
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
    flexShrink: 0,
  },
  hostname: {
    color: "var(--wmux-accent)",
    fontWeight: 600,
    fontSize: 14,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "var(--wmux-subtext)",
    fontSize: 12,
    cursor: "pointer",
    padding: "0 2px",
    lineHeight: 1,
    flexShrink: 0,
  },
  error: {
    padding: "8px",
    color: COLORS.red,
    textAlign: "center" as const,
    fontSize: 11,
  },
  loading: {
    padding: "8px",
    color: "var(--wmux-subtext)",
    textAlign: "center" as const,
    fontSize: 11,
  },
  bars: {
    padding: "6px 8px 4px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  },
  barRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  barLabel: {
    color: "var(--wmux-subtext)",
    fontSize: 13,
    width: 30,
    flexShrink: 0,
  },
  barTrack: {
    flex: 1,
    height: 6,
    backgroundColor: "var(--wmux-hairline-strong)",
    borderRadius: 2,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 2,
    transition: "width 0.3s ease",
  },
  barValue: {
    fontSize: 13,
    width: 36,
    textAlign: "right" as const,
    flexShrink: 0,
  },
  sparklines: {
    padding: "4px 8px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 1,
  },
  netSection: {
    padding: "4px 8px",
    borderTop: "1px solid var(--wmux-hairline)",
    display: "flex",
    flexDirection: "column" as const,
    gap: 2,
  },
  netRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  loadRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px 8px",
  },
  loadLabel: {
    color: "var(--wmux-subtext)",
    fontSize: 13,
    width: 30,
  },
  loadValues: {
    color: "var(--wmux-text)",
    fontSize: 13,
  },
  diskSection: {
    padding: "4px 8px",
    borderTop: "1px solid var(--wmux-hairline)",
    display: "flex",
    flexDirection: "column" as const,
    gap: 3,
  },
  diskRow: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  diskMount: {
    color: "var(--wmux-accent-2)",
    fontSize: 11,
    width: 32,
    flexShrink: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  diskBarTrack: {
    flex: 1,
    height: 6,
    backgroundColor: "var(--wmux-hairline-strong)",
    borderRadius: 2,
    overflow: "hidden",
  },
  diskBarFill: {
    height: "100%",
    borderRadius: 2,
    transition: "width 0.3s ease",
  },
  diskLabel: {
    color: COLORS.subtext,
    fontSize: 10,
    width: 50,
    textAlign: "right" as const,
    flexShrink: 0,
  },
  processes: {
    padding: "4px 8px 6px",
    borderTop: "1px solid var(--wmux-hairline)",
    marginTop: 4,
  },
  procHeader: {
    display: "flex",
    gap: 4,
    color: "var(--wmux-subtext)",
    fontSize: 12,
    fontWeight: 600,
    marginBottom: 1,
  },
  procRow: {
    display: "flex",
    gap: 4,
    fontSize: 12,
    lineHeight: "18px",
  },
  procCmd: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    color: "var(--wmux-subtext)",
  },
};
