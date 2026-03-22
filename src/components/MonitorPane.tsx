import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMonitorStore, type MonitorSnapshot } from "../stores/monitor";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

interface MonitorPaneProps {
  id: string;
  sshTarget: string;
  monitorId: string;
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
}

// Catppuccin Mocha colors
const COLORS = {
  bg: "#1e1e2e",
  surface: "#313244",
  text: "#cdd6f4",
  subtext: "#a6adc8",
  blue: "#89b4fa",
  green: "#a6e3a1",
  red: "#f38ba8",
  yellow: "#f9e2af",
  mauve: "#cba6f7",
  teal: "#94e2d5",
};

const EMPTY_SERIES: MonitorSnapshot[] = [];

export const MonitorPane = ({ id, sshTarget, monitorId }: MonitorPaneProps) => {
  const cpuChartRef = useRef<HTMLDivElement>(null);
  const memChartRef = useRef<HTMLDivElement>(null);
  const cpuPlotRef = useRef<uPlot | null>(null);
  const memPlotRef = useRef<uPlot | null>(null);
  const startedRef = useRef(false);

  const series = useMonitorStore((s) => s.series[monitorId]) ?? EMPTY_SERIES;
  const latest = series[series.length - 1] as MonitorSnapshot | undefined;

  // Start monitor on mount
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    invoke("start_monitor", { monitorId, sshTarget }).catch(console.error);

    return () => {
      invoke("stop_monitor", { monitorId }).catch(() => {});
      useMonitorStore.getState().clearMonitor(monitorId);
    };
  }, [monitorId, sshTarget]);

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
        claudeSessions: [],
      };

      useMonitorStore.getState().pushSnapshot(monitorId, snapshot);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [monitorId]);

  // Create/update CPU chart
  const updateCharts = useCallback(() => {
    if (series.length === 0) return;

    const timestamps = series.map((s) => s.timestamp);
    const cpuData = series.map((s) => s.cpuPercent);
    const memData = series.map((s) => s.memPercent);

    const chartOpts = (title: string, color: string, max: number): uPlot.Options => ({
      width: 1,
      height: 1,
      cursor: { show: false },
      legend: { show: false },
      axes: [
        {
          show: false,
        },
        {
          stroke: COLORS.subtext,
          grid: { stroke: COLORS.surface, width: 1 },
          ticks: { show: false },
          size: 40,
          values: (_u: uPlot, vals: number[]) => vals.map((v) => `${v}%`),
        },
      ],
      scales: {
        y: { min: 0, max },
      },
      series: [
        {},
        {
          label: title,
          stroke: color,
          width: 2,
          fill: `${color}20`,
        },
      ],
    });

    // CPU chart
    if (cpuChartRef.current) {
      const w = cpuChartRef.current.clientWidth;
      const h = cpuChartRef.current.clientHeight;
      if (w > 0 && h > 0) {
        if (cpuPlotRef.current) {
          cpuPlotRef.current.setSize({ width: w, height: h });
          cpuPlotRef.current.setData([timestamps, cpuData]);
        } else {
          const opts = chartOpts("CPU", COLORS.blue, 100);
          opts.width = w;
          opts.height = h;
          cpuPlotRef.current = new uPlot(opts, [timestamps, cpuData], cpuChartRef.current);
        }
      }
    }

    // Memory chart
    if (memChartRef.current) {
      const w = memChartRef.current.clientWidth;
      const h = memChartRef.current.clientHeight;
      if (w > 0 && h > 0) {
        if (memPlotRef.current) {
          memPlotRef.current.setSize({ width: w, height: h });
          memPlotRef.current.setData([timestamps, memData]);
        } else {
          const opts = chartOpts("MEM", COLORS.green, 100);
          opts.width = w;
          opts.height = h;
          memPlotRef.current = new uPlot(opts, [timestamps, memData], memChartRef.current);
        }
      }
    }
  }, [series]);

  useEffect(() => {
    updateCharts();
  }, [updateCharts]);

  // Resize charts on container resize
  useEffect(() => {
    const container = cpuChartRef.current?.parentElement?.parentElement;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      if (cpuPlotRef.current && cpuChartRef.current) {
        const w = cpuChartRef.current.clientWidth;
        const h = cpuChartRef.current.clientHeight;
        if (w > 0 && h > 0) cpuPlotRef.current.setSize({ width: w, height: h });
      }
      if (memPlotRef.current && memChartRef.current) {
        const w = memChartRef.current.clientWidth;
        const h = memChartRef.current.clientHeight;
        if (w > 0 && h > 0) memPlotRef.current.setSize({ width: w, height: h });
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Cleanup charts on unmount
  useEffect(() => {
    return () => {
      cpuPlotRef.current?.destroy();
      memPlotRef.current?.destroy();
    };
  }, []);

  const error = latest?.error;

  return (
    <div style={{ ...styles.container, "--monitor-id": id } as React.CSSProperties}>
      {/* Header bar */}
      <div style={styles.header}>
        <span style={styles.hostname}>{latest?.hostname || sshTarget}</span>
        <span style={styles.loadAvg}>
          Load: {latest ? latest.loadAvg.map((v) => v.toFixed(2)).join(" ") : "..."}
        </span>
      </div>

      {error ? (
        <div style={styles.error}>{error}</div>
      ) : (
        <>
          {/* Charts */}
          <div style={styles.chartsRow}>
            <div style={styles.chartBox}>
              <div style={styles.chartLabel}>
                CPU {latest ? `${latest.cpuPercent.toFixed(1)}%` : ""}
              </div>
              <div ref={cpuChartRef} style={styles.chart} />
            </div>
            <div style={styles.chartBox}>
              <div style={styles.chartLabel}>
                MEM {latest ? `${latest.memUsedMb}/${latest.memTotalMb} MB (${latest.memPercent.toFixed(1)}%)` : ""}
              </div>
              <div ref={memChartRef} style={styles.chart} />
            </div>
          </div>

          {/* Process table */}
          <div style={styles.processTable}>
            <div style={styles.processHeader}>
              <span style={{ width: 60 }}>PID</span>
              <span style={{ width: 80 }}>USER</span>
              <span style={{ width: 55, textAlign: "right" }}>CPU%</span>
              <span style={{ width: 55, textAlign: "right" }}>MEM%</span>
              <span style={{ flex: 1 }}>COMMAND</span>
            </div>
            {(latest?.processes ?? []).map((p) => (
              <div key={p.pid} style={styles.processRow}>
                <span style={{ width: 60, color: COLORS.subtext }}>{p.pid}</span>
                <span style={{ width: 80, color: COLORS.teal }}>{p.user}</span>
                <span style={{ width: 55, textAlign: "right", color: p.cpu > 50 ? COLORS.red : COLORS.text }}>
                  {p.cpu.toFixed(1)}
                </span>
                <span style={{ width: 55, textAlign: "right", color: p.mem > 50 ? COLORS.yellow : COLORS.text }}>
                  {p.mem.toFixed(1)}
                </span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: COLORS.subtext }}>
                  {p.command}
                </span>
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
    width: "100%",
    height: "100%",
    backgroundColor: COLORS.bg,
    color: COLORS.text,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
    fontSize: 12,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "4px 8px",
    backgroundColor: COLORS.surface,
    borderBottom: `1px solid ${COLORS.surface}`,
    flexShrink: 0,
  },
  hostname: {
    color: COLORS.blue,
    fontWeight: 600,
  },
  loadAvg: {
    color: COLORS.subtext,
    fontSize: 11,
  },
  error: {
    padding: 16,
    color: COLORS.red,
    textAlign: "center" as const,
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  chartsRow: {
    display: "flex",
    flexDirection: "row" as const,
    flex: 1,
    minHeight: 0,
  },
  chartBox: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    minWidth: 0,
    overflow: "hidden",
  },
  chartLabel: {
    padding: "2px 8px",
    color: COLORS.subtext,
    fontSize: 11,
    flexShrink: 0,
  },
  chart: {
    flex: 1,
    minHeight: 60,
    overflow: "hidden",
  },
  processTable: {
    flexShrink: 0,
    maxHeight: "40%",
    overflow: "auto",
    borderTop: `1px solid ${COLORS.surface}`,
  },
  processHeader: {
    display: "flex",
    gap: 4,
    padding: "2px 8px",
    backgroundColor: COLORS.surface,
    fontWeight: 600,
    fontSize: 11,
    position: "sticky" as const,
    top: 0,
  },
  processRow: {
    display: "flex",
    gap: 4,
    padding: "1px 8px",
    fontSize: 11,
    borderBottom: `1px solid ${COLORS.surface}33`,
  },
};
