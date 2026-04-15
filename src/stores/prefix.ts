import { create } from "zustand";

interface PrefixState {
  active: boolean;
  showPaneNumbers: boolean;
  historyOpen: boolean;
  setActive: (v: boolean) => void;
  setShowPaneNumbers: (v: boolean) => void;
  setHistoryOpen: (v: boolean) => void;
}

export const usePrefixStore = create<PrefixState>((set) => ({
  active: false,
  showPaneNumbers: false,
  historyOpen: false,
  setActive: (v) => set({ active: v }),
  setShowPaneNumbers: (v) => set({ showPaneNumbers: v }),
  setHistoryOpen: (v) => set({ historyOpen: v }),
}));

export const PREFIX_TIMEOUT_MS = 2000;
export const PANE_NUMBER_TIMEOUT_MS = 2000;
