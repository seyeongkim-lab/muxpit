import type { AgentProvider, MobileSession } from "./agentProtocol.ts";
import type { AgentWorkbenchViewSnapshot } from "./agentWorkbenchPersistence.ts";
import { readSessionRuntime, type AgentSessionRuntime } from "./agentSessionRuntime.ts";
import type { HostProfile } from "./hostProfiles.ts";

export type MobileProvider = AgentProvider;

export interface HostWorkbenchSource {
  profile: HostProfile;
  views: Partial<Record<MobileProvider, AgentWorkbenchViewSnapshot>>;
}

export interface UnifiedSessionEntry {
  profile: HostProfile;
  provider: MobileProvider;
  session: MobileSession;
  runtime: AgentSessionRuntime;
}

const MOBILE_PROVIDERS: readonly MobileProvider[] = [
  "claude",
  "codex",
  "gemini",
  "copilot",
  "opencode",
];

export const buildUnifiedSessionIndex = (
  sources: HostWorkbenchSource[],
): UnifiedSessionEntry[] => sources.flatMap(({ profile, views }) =>
  MOBILE_PROVIDERS.flatMap((provider) => {
    const view = views[provider];
    if (!view) return [];
    return view.sessions.map((session) => ({
      profile,
      provider,
      session,
      runtime: readSessionRuntime(view.runtimes, session.id),
    }));
  })).sort((left, right) =>
  (right.session.updatedAt ?? 0) - (left.session.updatedAt ?? 0));

export const unifiedSessionKey = (entry: UnifiedSessionEntry): string =>
  `${entry.profile.id}:${entry.provider}:${entry.session.id}`;
