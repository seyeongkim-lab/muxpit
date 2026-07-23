import { create } from "zustand";

interface SidebarLayoutState {
  monitorHeight: number;
  claudeHeight: number;
  filesRailWidth: number;
  fileViewerWidth: number;
  setMonitorHeight: (h: number) => void;
  setClaudeHeight: (h: number) => void;
  setFilesRailWidth: (w: number) => void;
  setFileViewerWidth: (w: number) => void;
}

type PersistedLayout = Pick<
  SidebarLayoutState,
  "monitorHeight" | "claudeHeight" | "filesRailWidth" | "fileViewerWidth"
>;

const STORAGE_KEY = "muxpit-sidebar-layout";
const DEFAULTS = {
  monitorHeight: 320,
  claudeHeight: 140,
  filesRailWidth: 272,
  fileViewerWidth: 560,
};
const MIN_H = 80;
const MAX_H = 800;
const FILES_RAIL_MIN_W = 180;
const FILES_RAIL_MAX_W = 640;
const FILE_VIEWER_MIN_W = 340;
const FILE_VIEWER_MAX_W = 1100;

const clamp = (v: number) => Math.max(MIN_H, Math.min(MAX_H, Math.round(v)));

export const clampFilesRailWidth = (v: number) =>
  Math.max(FILES_RAIL_MIN_W, Math.min(FILES_RAIL_MAX_W, Math.round(v)));

export const clampFileViewerWidth = (v: number) =>
  Math.max(FILE_VIEWER_MIN_W, Math.min(FILE_VIEWER_MAX_W, Math.round(v)));

const load = (): PersistedLayout => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        monitorHeight: clamp(p.monitorHeight ?? DEFAULTS.monitorHeight),
        claudeHeight: clamp(p.claudeHeight ?? DEFAULTS.claudeHeight),
        filesRailWidth: clampFilesRailWidth(p.filesRailWidth ?? DEFAULTS.filesRailWidth),
        fileViewerWidth: clampFileViewerWidth(p.fileViewerWidth ?? DEFAULTS.fileViewerWidth),
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
  fileViewerWidth: s.fileViewerWidth,
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
  setFileViewerWidth: (w) => {
    const v = clampFileViewerWidth(w);
    set({ fileViewerWidth: v });
    save({ ...persisted(get()), fileViewerWidth: v });
  },
}));
