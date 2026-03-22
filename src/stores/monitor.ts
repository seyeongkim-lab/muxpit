import { create } from "zustand";

export interface ProcessInfo {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  command: string;
}

export interface NetInfo {
  rxBytesPerSec: number;
  txBytesPerSec: number;
  linkSpeedMbps: number | null;
}

export interface DiskInfo {
  mount: string;
  totalGb: number;
  usedGb: number;
  percent: number;
}

export interface ClaudeSessionInfo {
  project: string;
  projectPath: string;
  sessionId: string;
  startedAt: string | null;
  lastActivity: string | null;
  messageCount: number;
}

export interface MonitorSnapshot {
  cpuPercent: number;
  memTotalMb: number;
  memUsedMb: number;
  memPercent: number;
  loadAvg: [number, number, number];
  processes: ProcessInfo[];
  hostname: string;
  timestamp: number;
  error: string | null;
  net: NetInfo | null;
  disks: DiskInfo[];
  claudeSessions: ClaudeSessionInfo[];
}

interface MonitorDataState {
  // monitorId -> time series (last 60 snapshots = ~5 min at 5s interval)
  series: Record<string, MonitorSnapshot[]>;
  pushSnapshot: (monitorId: string, snapshot: MonitorSnapshot) => void;
  clearMonitor: (monitorId: string) => void;
}

const MAX_POINTS = 60;

export const useMonitorStore = create<MonitorDataState>((set) => ({
  series: {},

  pushSnapshot: (monitorId, snapshot) =>
    set((s) => {
      const existing = s.series[monitorId] ?? [];
      const updated = [...existing, snapshot].slice(-MAX_POINTS);
      return { series: { ...s.series, [monitorId]: updated } };
    }),

  clearMonitor: (monitorId) =>
    set((s) => {
      const { [monitorId]: _, ...rest } = s.series;
      return { series: rest };
    }),
}));
