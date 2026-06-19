import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { sanitizeTmuxSessionName } from "../utils/tmuxSession";
import { pickActiveSession, reconcileActiveSession } from "../utils/tmuxSessionState";
import type { SshConnection } from "../utils/sshConnection";

export interface TmuxSession {
  id: string;          // "$0"
  name: string;
  attached: boolean;
  windows: number;
  activity: number;
}

export interface AttachInfo {
  sshCommand: string;
  sshConnection?: SshConnection;
  wrapperSession: string;
  activeSession: string;
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

  attach: (wsId: string, sshCommand: string, wrapperSession: string, sshConnection?: SshConnection) => void;
  detach: (wsId: string) => void;
  refresh: (wsId: string) => Promise<void>;
  switchTo: (wsId: string, sessionId: string) => Promise<void>;
  createNew: (wsId: string, name?: string) => Promise<void>;
  killSession: (wsId: string, sessionId: string) => Promise<void>;
  pauseAll: () => void;
  resumeAll: () => void;
}

const POLL_INTERVAL_MS = 5000;
const MAX_BACKOFF_MS = 30000;

// Timers + paused state live outside the store — reactivity doesn't help here
// and keeping them in zustand state would trigger spurious re-renders.
const timers = new Map<string, ReturnType<typeof setTimeout>>();
// Consecutive refresh failures per workspace. Drives polling backoff so a host
// that's down isn't hammered every 5s with overlapping ssh execs.
const failures = new Map<string, number>();
let paused = false;

const sameAttachContext = (
  prev: AttachInfo | undefined,
  sshCommand: string,
  sshConnection: SshConnection | undefined,
  wrapperSession: string,
): boolean =>
  !!prev &&
  prev.sshCommand === sshCommand &&
  JSON.stringify(prev.sshConnection ?? null) === JSON.stringify(sshConnection ?? null) &&
  prev.wrapperSession === wrapperSession;

const nextDelay = (wsId: string): number => {
  const f = failures.get(wsId) ?? 0;
  if (f === 0) return POLL_INTERVAL_MS;
  return Math.min(POLL_INTERVAL_MS * 2 ** f, MAX_BACKOFF_MS);
};

// Self-rescheduling poll: each refresh must finish before the next is armed (so
// a slow/hung ssh exec can't stack up), and the delay backs off on failure.
// `isActive` lets a tick that resolves after detach/pause skip re-arming.
const startTimer = (
  wsId: string,
  refresh: () => Promise<void>,
  isActive: () => boolean,
) => {
  stopTimer(wsId);
  if (paused) return;
  const tick = async () => {
    await refresh();
    if (paused || !isActive()) return;
    timers.set(wsId, setTimeout(tick, nextDelay(wsId)));
  };
  timers.set(wsId, setTimeout(tick, nextDelay(wsId)));
};

const stopTimer = (wsId: string) => {
  const t = timers.get(wsId);
  if (t) {
    clearTimeout(t);
    timers.delete(wsId);
  }
};

type StoreGet = () => TmuxSessionsState;
type StoreSet = (fn: (state: TmuxSessionsState) => Partial<TmuxSessionsState>) => void;

const invokeSwitchClient = (ctx: AttachInfo, targetSession: string): Promise<void> =>
  invoke<void>("tmux_switch_client", {
    sshCommand: ctx.sshCommand,
    sshConnection: ctx.sshConnection ?? null,
    wrapperSession: ctx.activeSession,
    targetSession,
  });

const switchClientWithActiveRetry = async (
  wsId: string,
  targetSession: string,
  ctx: AttachInfo,
  get: StoreGet,
): Promise<void> => {
  try {
    await invokeSwitchClient(ctx, targetSession);
    return;
  } catch (firstError) {
    await get().refresh(wsId);
    const refreshed = get()._attach[wsId];
    if (!refreshed || refreshed.activeSession === ctx.activeSession) {
      throw firstError;
    }
    await invokeSwitchClient(refreshed, targetSession);
  }
};

const setActiveSession = (
  wsId: string,
  activeSession: string,
  set: StoreSet,
) => {
  set((s) => {
    const current = s._attach[wsId];
    if (!current) return {};
    return {
      _attach: {
        ...s._attach,
        [wsId]: { ...current, activeSession },
      },
    };
  });
};

export const useTmuxSessionsStore = create<TmuxSessionsState>((set, get) => ({
  byWs: {},
  _attach: {},

  attach: (wsId, sshCommand, wrapperSession, sshConnection) => {
    // Always normalise the wrapper to its server-side form so older saved
    // workspaces (which stored the unsanitised `wmux-10.0.0.5`) match what
    // tmux actually returns from list-sessions (`wmux-10_0_0_5`).
    const wrapper = sanitizeTmuxSessionName(wrapperSession);
    // Idempotent: re-attaching with the same context is a no-op beyond a
    // refresh. Different ssh/wrapper replaces and resets state.
    const prev = get()._attach[wsId];
    if (sameAttachContext(prev, sshCommand, sshConnection, wrapper)) {
      void get().refresh(wsId);
      return;
    }
    set((s) => ({
      _attach: { ...s._attach, [wsId]: { sshCommand, sshConnection, wrapperSession: wrapper, activeSession: wrapper } },
      byWs: {
        ...s.byWs,
        [wsId]: { sessions: [], loading: true, error: null, lastFetch: 0 },
      },
    }));
    void get().refresh(wsId);
    startTimer(
      wsId,
      () => get().refresh(wsId),
      () => !!get()._attach[wsId],
    );
  },

  detach: (wsId) => {
    stopTimer(wsId);
    failures.delete(wsId);
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
        sshConnection: ctx.sshConnection ?? null,
      });
      failures.delete(wsId);
      set((s) => ({
        _attach: s._attach[wsId]
          ? {
              ...s._attach,
              [wsId]: reconcileActiveSession(s._attach[wsId], sessions),
            }
          : s._attach,
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
      failures.set(wsId, (failures.get(wsId) ?? 0) + 1);
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
    await switchClientWithActiveRetry(wsId, sessionId, ctx, get);
    setActiveSession(wsId, sessionId, set);
    await get().refresh(wsId);
  },

  createNew: async (wsId, name) => {
    const ctx = get()._attach[wsId];
    if (!ctx) return;
    const newId = await invoke<string>("tmux_new_session", {
      sshCommand: ctx.sshCommand,
      sshConnection: ctx.sshConnection ?? null,
      name: name && name.trim() ? name.trim() : null,
    });
    // Switch to the freshly created session so the user lands in it.
    await switchClientWithActiveRetry(wsId, newId, ctx, get);
    setActiveSession(wsId, newId, set);
    await get().refresh(wsId);
  },

  killSession: async (wsId, sessionId) => {
    const ctx = get()._attach[wsId];
    if (!ctx) return;
    await invoke("tmux_kill_session", {
      sshCommand: ctx.sshCommand,
      sshConnection: ctx.sshConnection ?? null,
      session: sessionId,
    });
    // tmux automatically migrates the attached client to a remaining session;
    // refresh picks up the new active state.
    await get().refresh(wsId);
  },

  pauseAll: () => {
    paused = true;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  },

  resumeAll: () => {
    paused = false;
    const state = get();
    for (const wsId of Object.keys(state._attach)) {
      void state.refresh(wsId);
      startTimer(
        wsId,
        () => get().refresh(wsId),
        () => !!get()._attach[wsId],
      );
    }
  },
}));

/** Snapshot of attach contexts for read-only Sidebar lookups. */
export const useAttachInfo = () => useTmuxSessionsStore((s) => s._attach);

export { pickActiveSession, reconcileActiveSession };
