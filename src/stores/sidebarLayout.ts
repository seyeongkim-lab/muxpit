import { create } from "zustand";

interface SidebarLayoutState {
  monitorHeight: number;
  claudeHeight: number;
  setMonitorHeight: (h: number) => void;
  setClaudeHeight: (h: number) => void;
}

const STORAGE_KEY = "wmux-sidebar-layout";
const DEFAULTS = { monitorHeight: 320, claudeHeight: 140 };
const MIN_H = 80;
const MAX_H = 800;

const clamp = (v: number) => Math.max(MIN_H, Math.min(MAX_H, Math.round(v)));

const load = (): Pick<SidebarLayoutState, "monitorHeight" | "claudeHeight"> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        monitorHeight: clamp(p.monitorHeight ?? DEFAULTS.monitorHeight),
        claudeHeight: clamp(p.claudeHeight ?? DEFAULTS.claudeHeight),
      };
    }
  } catch {}
  return DEFAULTS;
};

const save = (state: Pick<SidebarLayoutState, "monitorHeight" | "claudeHeight">) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
};

const initial = load();

export const useSidebarLayoutStore = create<SidebarLayoutState>((set, get) => ({
  ...initial,
  setMonitorHeight: (h) => {
    const v = clamp(h);
    set({ monitorHeight: v });
    save({ monitorHeight: v, claudeHeight: get().claudeHeight });
  },
  setClaudeHeight: (h) => {
    const v = clamp(h);
    set({ claudeHeight: v });
    save({ claudeHeight: v, monitorHeight: get().monitorHeight });
  },
}));
