import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { sanitizeTmuxSessionName } from "../utils/tmuxSession";

export interface TmuxSession {
  id: string;          // "$0"
  name: string;
  attached: boolean;
  windows: number;
  activity: number;
}

interface AttachInfo {
  sshCommand: string;
  wrapperSession: string;
}

interface SessionEntry {
  sessions: TmuxSession[];
  loading: boolean;
  error: string | null;
  lastFetch: number;
}

interface TmuxSessionsState {
  /** Per-workspace session list snapshots. */
  byWs: Record<string, SessionEntry>;
  /** SSH/wrapper context kept outside React tree to avoid re-render churn. */
  _attach: Record<string, AttachInfo>;

  attach: (wsId: string, sshCommand: string, wrapperSession: string) => void;
  detach: (wsId: string) => void;
  refresh: (wsId: string) => Promise<void>;
  switchTo: (wsId: string, sessionId: string) => Promise<void>;
  createNew: (wsId: string, name?: string) => Promise<void>;
  killSession: (wsId: string, sessionId: string) => Promise<void>;
  pauseAll: () => void;
  resumeAll: () => void;
}

const POLL_INTERVAL_MS = 5000;

// Timers + paused state live outside the store — reactivity doesn't help here
// and keeping them in zustand state would trigger spurious re-renders.
const timers = new Map<string, ReturnType<typeof setInterval>>();
let paused = false;

const startTimer = (wsId: string, refresh: () => void) => {
  stopTimer(wsId);
  if (paused) return;
  timers.set(wsId, setInterval(refresh, POLL_INTERVAL_MS));
};

const stopTimer = (wsId: string) => {
  const t = timers.get(wsId);
  if (t) {
    clearInterval(t);
    timers.delete(wsId);
  }
};

export const useTmuxSessionsStore = create<TmuxSessionsState>((set, get) => ({
  byWs: {},
  _attach: {},

  attach: (wsId, sshCommand, wrapperSession) => {
    // Always normalise the wrapper to its server-side form so older saved
    // workspaces (which stored the unsanitised `wmux-192.168.0.7`) match what
    // tmux actually returns from list-sessions (`wmux-192_168_0_7`).
    const wrapper = sanitizeTmuxSessionName(wrapperSession);
    // Idempotent: re-attaching with the same context is a no-op beyond a
    // refresh. Different ssh/wrapper replaces and resets state.
    const prev = get()._attach[wsId];
    if (prev && prev.sshCommand === sshCommand && prev.wrapperSession === wrapper) {
      void get().refresh(wsId);
      return;
    }
    console.log("[wmux] tmuxSessions attach", { wsId, wrapper });
    set((s) => ({
      _attach: { ...s._attach, [wsId]: { sshCommand, wrapperSession: wrapper } },
      byWs: {
        ...s.byWs,
        [wsId]: { sessions: [], loading: true, error: null, lastFetch: 0 },
      },
    }));
    void get().refresh(wsId);
    startTimer(wsId, () => {
      void get().refresh(wsId);
    });
  },

  detach: (wsId) => {
    stopTimer(wsId);
    set((s) => {
      const { [wsId]: _a, ..._attach } = s._attach;
      const { [wsId]: _b, ...byWs } = s.byWs;
      return { _attach, byWs };
    });
  },

  refresh: async (wsId) => {
    const ctx = get()._attach[wsId];
    if (!ctx) return;
    try {
      const sessions = await invoke<TmuxSession[]>("tmux_list_sessions", {
        sshCommand: ctx.sshCommand,
      });
      console.log("[wmux] tmuxSessions refresh", { wsId, count: sessions.length, names: sessions.map((s) => s.name) });
      set((s) => ({
        byWs: {
          ...s.byWs,
          [wsId]: {
            sessions,
            loading: false,
            error: null,
            lastFetch: Date.now(),
          },
        },
      }));
    } catch (e) {
      set((s) => ({
        byWs: {
          ...s.byWs,
          [wsId]: {
            sessions: s.byWs[wsId]?.sessions ?? [],
            loading: false,
            error: String(e),
            lastFetch: Date.now(),
          },
        },
      }));
    }
  },

  switchTo: async (wsId, sessionId) => {
    const ctx = get()._attach[wsId];
    if (!ctx) return;
    await invoke("tmux_switch_client", {
      sshCommand: ctx.sshCommand,
      wrapperSession: ctx.wrapperSession,
      targetSession: sessionId,
    });
    await get().refresh(wsId);
  },

  createNew: async (wsId, name) => {
    const ctx = get()._attach[wsId];
    if (!ctx) return;
    const newId = await invoke<string>("tmux_new_session", {
      sshCommand: ctx.sshCommand,
      name: name && name.trim() ? name.trim() : null,
    });
    // Switch to the freshly created session so the user lands in it.
    await invoke("tmux_switch_client", {
      sshCommand: ctx.sshCommand,
      wrapperSession: ctx.wrapperSession,
      targetSession: newId,
    });
    await get().refresh(wsId);
  },

  killSession: async (wsId, sessionId) => {
    const ctx = get()._attach[wsId];
    if (!ctx) return;
    await invoke("tmux_kill_session", {
      sshCommand: ctx.sshCommand,
      session: sessionId,
    });
    // tmux automatically migrates the attached client to a remaining session;
    // refresh picks up the new active state.
    await get().refresh(wsId);
  },

  pauseAll: () => {
    paused = true;
    for (const t of timers.values()) clearInterval(t);
    timers.clear();
  },

  resumeAll: () => {
    paused = false;
    const state = get();
    for (const wsId of Object.keys(state._attach)) {
      void state.refresh(wsId);
      startTimer(wsId, () => {
        void state.refresh(wsId);
      });
    }
  },
}));

/** Snapshot of attach contexts for read-only Sidebar lookups. */
export const useAttachInfo = () => useTmuxSessionsStore((s) => s._attach);

/** Identify the attached non-wrapper session, falling back to the wrapper itself. */
export const pickActiveSession = (
  sessions: TmuxSession[],
  wrapperName: string,
): TmuxSession | null => {
  const attached = sessions.filter((s) => s.attached);
  // Prefer the most recently active non-wrapper attached session.
  const nonWrapper = attached
    .filter((s) => s.name !== wrapperName)
    .sort((a, b) => b.activity - a.activity);
  if (nonWrapper.length > 0) return nonWrapper[0];
  return attached.find((s) => s.name === wrapperName) ?? attached[0] ?? null;
};
