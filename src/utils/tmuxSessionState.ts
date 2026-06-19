export interface TmuxSessionSnapshot {
  id: string;
  name: string;
  attached: boolean;
  windows: number;
  activity: number;
}

export interface TmuxAttachSnapshot {
  wrapperSession: string;
  activeSession: string;
}

export const pickActiveSession = <T extends TmuxSessionSnapshot>(
  sessions: T[],
  wrapperName: string,
): T | null => {
  const attached = sessions.filter((s) => s.attached);
  const nonWrapper = attached
    .filter((s) => s.name !== wrapperName)
    .sort((a, b) => b.activity - a.activity);
  if (nonWrapper.length > 0) return nonWrapper[0];
  return attached.find((s) => s.name === wrapperName) ?? attached[0] ?? null;
};

export const reconcileActiveSession = <T extends TmuxAttachSnapshot>(
  ctx: T,
  sessions: TmuxSessionSnapshot[],
): T => {
  const active = pickActiveSession(sessions, ctx.wrapperSession);
  if (!active) return ctx;
  const activeSession = active.id || active.name;
  return activeSession && activeSession !== ctx.activeSession
    ? { ...ctx, activeSession }
    : ctx;
};
