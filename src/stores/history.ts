import { create } from "zustand";

export interface HistoryEntry {
  id: string;
  workspaceId: string;
  leafId: string;
  command: string;
  timestamp: number;
}

interface HistoryState {
  entries: HistoryEntry[];
  addEntry: (workspaceId: string, leafId: string, command: string) => void;
  clear: () => void;
}

const MAX_ENTRIES = 500;
let counter = 0;

const loadSaved = (): HistoryEntry[] => {
  try {
    const raw = localStorage.getItem("muxpit-history") ?? localStorage.getItem("wmux-history");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.slice(-MAX_ENTRIES);
  } catch {}
  return [];
};

const save = (entries: HistoryEntry[]) => {
  try {
    localStorage.setItem("muxpit-history", JSON.stringify(entries));
  } catch {}
};

export const useHistoryStore = create<HistoryState>((set) => ({
  entries: loadSaved(),
  addEntry: (workspaceId, leafId, command) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    set((s) => {
      // Dedup: if the most recent entry is the same command, skip.
      const last = s.entries[s.entries.length - 1];
      if (last && last.command === trimmed) return s;
      const next: HistoryEntry[] = [
        ...s.entries,
        {
          id: `h-${Date.now()}-${counter++}`,
          workspaceId,
          leafId,
          command: trimmed,
          timestamp: Date.now(),
        },
      ];
      if (next.length > MAX_ENTRIES) next.splice(0, next.length - MAX_ENTRIES);
      save(next);
      return { entries: next };
    });
  },
  clear: () => {
    save([]);
    set({ entries: [] });
  },
}));
