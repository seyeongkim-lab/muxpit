import { create } from "zustand";

interface SidebarLayoutState {
  monitorHeight: number;
  claudeHeight: number;
  filesRailWidth: number;
  setMonitorHeight: (h: number) => void;
  setClaudeHeight: (h: number) => void;
  setFilesRailWidth: (w: number) => void;
}

type PersistedLayout = Pick<
  SidebarLayoutState,
  "monitorHeight" | "claudeHeight" | "filesRailWidth"
>;

const STORAGE_KEY = "wmux-sidebar-layout";
const DEFAULTS = { monitorHeight: 320, claudeHeight: 140, filesRailWidth: 272 };
const MIN_H = 80;
const MAX_H = 800;
const FILES_RAIL_MIN_W = 180;
const FILES_RAIL_MAX_W = 640;

const clamp = (v: number) => Math.max(MIN_H, Math.min(MAX_H, Math.round(v)));

export const clampFilesRailWidth = (v: number) =>
  Math.max(FILES_RAIL_MIN_W, Math.min(FILES_RAIL_MAX_W, Math.round(v)));

const load = (): PersistedLayout => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        monitorHeight: clamp(p.monitorHeight ?? DEFAULTS.monitorHeight),
        claudeHeight: clamp(p.claudeHeight ?? DEFAULTS.claudeHeight),
        filesRailWidth: clampFilesRailWidth(p.filesRailWidth ?? DEFAULTS.filesRailWidth),
      };
    }
  } catch {}
  return DEFAULTS;
};

const save = (state: PersistedLayout) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
};

const persisted = (s: SidebarLayoutState): PersistedLayout => ({
  monitorHeight: s.monitorHeight,
  claudeHeight: s.claudeHeight,
  filesRailWidth: s.filesRailWidth,
});

const initial = load();

export const useSidebarLayoutStore = create<SidebarLayoutState>((set, get) => ({
  ...initial,
  setMonitorHeight: (h) => {
    const v = clamp(h);
    set({ monitorHeight: v });
    save({ ...persisted(get()), monitorHeight: v });
  },
  setClaudeHeight: (h) => {
    const v = clamp(h);
    set({ claudeHeight: v });
    save({ ...persisted(get()), claudeHeight: v });
  },
  setFilesRailWidth: (w) => {
    const v = clampFilesRailWidth(w);
    set({ filesRailWidth: v });
    save({ ...persisted(get()), filesRailWidth: v });
  },
}));
