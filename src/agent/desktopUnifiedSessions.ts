import type { AiKind } from "../stores/workspace.ts";
import type { MobileSession } from "../mobile/agentProtocol.ts";
import type { AgentWorkbenchViewSnapshot } from "../mobile/agentWorkbenchPersistence.ts";
import { readSessionRuntime, type AgentSessionRuntime } from "../mobile/agentSessionRuntime.ts";

export interface DesktopSessionSource {
  contextKey: string;
  contextLabel: string;
  views: Partial<Record<AiKind, AgentWorkbenchViewSnapshot>>;
}

export interface DesktopSessionEntry {
  contextKey: string;
  contextLabel: string;
  provider: AiKind;
  session: MobileSession;
  runtime: AgentSessionRuntime;
  closed: boolean;
}

export const buildDesktopSessionIndex = (
  sources: DesktopSessionSource[],
): DesktopSessionEntry[] => sources.flatMap(({ contextKey, contextLabel, views }) =>
  Object.entries(views).flatMap(([provider, view]) => view.sessions.map((session) => ({
    contextKey,
    contextLabel,
    provider: provider as AiKind,
    session,
    runtime: readSessionRuntime(view.runtimes, session.id),
    closed: view.closedSessionIds?.includes(session.id) ?? false,
  })))).sort((left, right) =>
  (right.session.updatedAt ?? 0) - (left.session.updatedAt ?? 0));

export const desktopSessionKey = (entry: DesktopSessionEntry): string =>
  `${entry.contextKey}:${entry.provider}:${entry.session.id}`;
