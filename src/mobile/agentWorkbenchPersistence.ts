import type { MobileSession, MobileTimelineItem } from "./agentProtocol.ts";
import {
  createSessionRuntime,
  type AgentExecutionSettings,
  type AgentSessionRuntime,
  type AgentSessionRuntimes,
} from "./agentSessionRuntime.ts";

export interface AgentWorkbenchViewSnapshot {
  sessions: MobileSession[];
  activeSessionId: string | null;
  closedSessionIds?: string[];
  runtimes: AgentSessionRuntimes;
}

export interface AgentWorkbenchSnapshot<Provider extends string> {
  provider: Provider;
  profileId?: string;
  views: Partial<Record<Provider, AgentWorkbenchViewSnapshot>>;
}

interface StoredAgentWorkbenchSnapshot {
  version: 1;
  provider: string;
  profileId?: string;
  views: Record<string, unknown>;
}

interface StoredAgentSessionRuntime {
  items: MobileTimelineItem[];
  queue: string[];
  draft: string;
  queueMode: boolean;
  executionSettings: AgentExecutionSettings;
  connectionState: "idle" | "connected" | "disconnected";
  historyState: "idle" | "loaded";
}

const MAX_CACHED_TIMELINE_ITEMS = 500;

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const timelineItem = (value: unknown): MobileTimelineItem | undefined => {
  const item = objectValue(value);
  if (
    !item
    || typeof item.id !== "string"
    || typeof item.text !== "string"
    || !["user", "assistant", "tool", "status"].includes(String(item.kind))
  ) return undefined;
  return {
    id: item.id,
    kind: item.kind as MobileTimelineItem["kind"],
    text: item.text,
    ...(typeof item.title === "string" ? { title: item.title } : {}),
  };
};

const sessionValue = (value: unknown): MobileSession | undefined => {
  const session = objectValue(value);
  if (
    !session
    || typeof session.id !== "string"
    || typeof session.title !== "string"
    || typeof session.provider !== "string"
  ) return undefined;
  return {
    id: session.id,
    title: session.title,
    provider: session.provider as MobileSession["provider"],
    ...(typeof session.cwd === "string" ? { cwd: session.cwd } : {}),
    ...(typeof session.updatedAt === "number" ? { updatedAt: session.updatedAt } : {}),
  };
};

const executionSettingsValue = (value: unknown): AgentExecutionSettings => {
  const settings = objectValue(value);
  return {
    model: typeof settings?.model === "string" ? settings.model : null,
    effort: typeof settings?.effort === "string" ? settings.effort : null,
    serviceTier: typeof settings?.serviceTier === "string" ? settings.serviceTier : null,
  };
};

const restoredRuntime = (value: unknown): AgentSessionRuntime | undefined => {
  const runtime = objectValue(value);
  if (!runtime) return undefined;
  const items = Array.isArray(runtime.items)
    ? runtime.items
        .map(timelineItem)
        .filter((item): item is MobileTimelineItem => item !== undefined)
        .slice(-MAX_CACHED_TIMELINE_ITEMS)
    : [];
  const queue = Array.isArray(runtime.queue)
    ? runtime.queue.filter((item): item is string => typeof item === "string")
    : [];
  return {
    ...createSessionRuntime(),
    items,
    queue,
    draft: typeof runtime.draft === "string" ? runtime.draft : "",
    queueMode: runtime.queueMode === true,
    executionSettings: executionSettingsValue(runtime.executionSettings),
    connectionState: runtime.connectionState === "idle" ? "idle" : "disconnected",
    historyState: runtime.historyState === "loaded" ? "loaded" : "idle",
  };
};

const restoredRuntimes = (value: unknown): AgentSessionRuntimes => {
  const runtimes = objectValue(value);
  if (!runtimes) return {};
  const restored: AgentSessionRuntimes = {};
  for (const [key, runtimeValue] of Object.entries(runtimes)) {
    const runtime = restoredRuntime(runtimeValue);
    if (runtime) restored[key] = runtime;
  }
  return restored;
};

const restoredView = (value: unknown): AgentWorkbenchViewSnapshot | undefined => {
  const view = objectValue(value);
  if (!view) return undefined;
  const sessions = Array.isArray(view.sessions)
    ? view.sessions
        .map(sessionValue)
        .filter((session): session is MobileSession => session !== undefined)
    : [];
  const activeSessionId = typeof view.activeSessionId === "string"
    ? view.activeSessionId
    : null;
  const closedSessionIds = Array.isArray(view.closedSessionIds)
    ? [...new Set(view.closedSessionIds.filter((id): id is string => typeof id === "string"))]
    : [];
  return {
    sessions,
    activeSessionId,
    closedSessionIds,
    runtimes: restoredRuntimes(view.runtimes),
  };
};

const storedRuntime = (runtime: AgentSessionRuntime): StoredAgentSessionRuntime => ({
  items: runtime.items.slice(-MAX_CACHED_TIMELINE_ITEMS),
  queue: runtime.queue,
  draft: runtime.draft,
  queueMode: runtime.queueMode,
  executionSettings: runtime.executionSettings,
  connectionState: runtime.connectionState,
  historyState: runtime.historyState === "loaded" ? "loaded" : "idle",
});

const storedView = (view: AgentWorkbenchViewSnapshot): Record<string, unknown> => ({
  sessions: view.sessions,
  activeSessionId: view.activeSessionId,
  closedSessionIds: view.closedSessionIds ?? [],
  runtimes: Object.fromEntries(Object.entries(view.runtimes).map(([key, runtime]) => [
    key,
    storedRuntime(runtime),
  ])),
});

export const loadAgentWorkbenchSnapshot = <Provider extends string>(
  storageKey: string,
  providers: readonly Provider[],
): AgentWorkbenchSnapshot<Provider> | undefined => {
  try {
    const stored = objectValue(JSON.parse(localStorage.getItem(storageKey) ?? "null"));
    if (!stored || stored.version !== 1 || typeof stored.provider !== "string") return undefined;
    if (!providers.includes(stored.provider as Provider)) return undefined;
    const storedViews = objectValue(stored.views);
    if (!storedViews) return undefined;
    const views: Partial<Record<Provider, AgentWorkbenchViewSnapshot>> = {};
    for (const provider of providers) {
      const view = restoredView(storedViews[provider]);
      if (view) views[provider] = view;
    }
    return {
      provider: stored.provider as Provider,
      ...(typeof stored.profileId === "string" ? { profileId: stored.profileId } : {}),
      views,
    };
  } catch {
    return undefined;
  }
};

export const saveAgentWorkbenchSnapshot = <Provider extends string>(
  storageKey: string,
  snapshot: AgentWorkbenchSnapshot<Provider>,
): void => {
  const stored: StoredAgentWorkbenchSnapshot = {
    version: 1,
    provider: snapshot.provider,
    ...(snapshot.profileId ? { profileId: snapshot.profileId } : {}),
    views: Object.fromEntries(Object.entries(snapshot.views).map(([provider, view]) => [
      provider,
      storedView(view as AgentWorkbenchViewSnapshot),
    ])),
  };
  try {
    localStorage.setItem(storageKey, JSON.stringify(stored));
  } catch {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Storage can be unavailable. The live workbench remains usable.
    }
  }
};
