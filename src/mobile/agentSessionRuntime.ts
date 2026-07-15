import type {
  AgentPermissionOption,
  MobileTimelineItem,
} from "./agentProtocol.ts";

export interface AgentApprovalRequest {
  requestId: string | number;
  title: string;
  detail: string;
  options?: AgentPermissionOption[];
}

export interface AgentSessionRuntime {
  items: MobileTimelineItem[];
  approvals: AgentApprovalRequest[];
  activeTurnId: string | null;
  running: boolean;
  waiting: boolean;
  queue: string[];
  draft: string;
  queueMode: boolean;
  historyState: "idle" | "loading" | "loaded";
  historyBaseItems: MobileTimelineItem[];
}

export type AgentSessionRuntimes = Record<string, AgentSessionRuntime>;

const NEW_SESSION_KEY = "__wmux_new_session__";

export const sessionRuntimeKey = (sessionId: string | null | undefined): string =>
  sessionId || NEW_SESSION_KEY;

export const createSessionRuntime = (): AgentSessionRuntime => ({
  items: [],
  approvals: [],
  activeTurnId: null,
  running: false,
  waiting: false,
  queue: [],
  draft: "",
  queueMode: false,
  historyState: "idle",
  historyBaseItems: [],
});

export type AgentChannelPurpose = "provider" | "claude-list" | "claude-history";

export const shouldProcessAgentChannelPayload = (
  purpose: AgentChannelPurpose,
  handledPayload: boolean,
): boolean => purpose === "provider" || !handledPayload;

export const sessionRuntimeLabel = (runtime: AgentSessionRuntime): "Ready" | "Running" | "Waiting" =>
  runtime.waiting ? "Waiting" : runtime.running ? "Running" : "Ready";

export const readSessionRuntime = (
  runtimes: AgentSessionRuntimes,
  sessionId: string | null | undefined,
): AgentSessionRuntime => runtimes[sessionRuntimeKey(sessionId)] ?? createSessionRuntime();

export const updateSessionRuntime = (
  runtimes: AgentSessionRuntimes,
  sessionId: string | null | undefined,
  update: (runtime: AgentSessionRuntime) => AgentSessionRuntime,
): AgentSessionRuntimes => {
  const key = sessionRuntimeKey(sessionId);
  return { ...runtimes, [key]: update(readSessionRuntime(runtimes, sessionId)) };
};

export const moveSessionRuntime = (
  runtimes: AgentSessionRuntimes,
  fromSessionId: string | null | undefined,
  toSessionId: string,
): AgentSessionRuntimes => {
  const fromKey = sessionRuntimeKey(fromSessionId);
  const toKey = sessionRuntimeKey(toSessionId);
  if (fromKey === toKey || !runtimes[fromKey]) return runtimes;
  const next = { ...runtimes, [toKey]: runtimes[fromKey] };
  delete next[fromKey];
  return next;
};

const withoutLoadingItems = (items: MobileTimelineItem[]): MobileTimelineItem[] =>
  items.filter((item) => !item.id.startsWith("loading-"));

export const beginSessionHistory = (
  runtime: AgentSessionRuntime,
  sessionId: string,
): AgentSessionRuntime => {
  const items = withoutLoadingItems(runtime.items);
  return {
    ...runtime,
    historyState: "loading",
    historyBaseItems: items.map((item) => ({ ...item })),
    items: items.length > 0
      ? items
      : [{ id: `loading-${sessionId}`, kind: "status", text: "Loading session…" }],
  };
};

export const completeSessionHistory = (
  runtime: AgentSessionRuntime,
  historyItems: MobileTimelineItem[],
): AgentSessionRuntime => {
  const baselineItems = runtime.historyState === "loading"
    ? runtime.historyBaseItems
    : withoutLoadingItems(runtime.items);
  const exactlyMatchesBaseline = (item: MobileTimelineItem): boolean =>
    baselineItems.some((baseline) =>
      baseline.id === item.id
      && baseline.kind === item.kind
      && baseline.text === item.text
      && baseline.title === item.title);
  const appearsInHistory = (item: MobileTimelineItem): boolean =>
    historyItems.some((historyItem) =>
      historyItem.id === item.id
      || (
        historyItem.kind === item.kind
        && historyItem.text === item.text
        && historyItem.title === item.title
      ));
  let lastHistoryItemIndex = -1;
  for (let index = baselineItems.length - 1; index >= 0; index -= 1) {
    if (!appearsInHistory(baselineItems[index])) continue;
    lastHistoryItemIndex = index;
    break;
  }
  const cachedTail = baselineItems
    .slice(lastHistoryItemIndex + 1)
    .filter((item) => !appearsInHistory(item));
  const liveItems = runtime.historyState === "loading"
    ? withoutLoadingItems(runtime.items).filter((item) => !exactlyMatchesBaseline(item))
    : [];
  const preservedItems = [
    ...cachedTail.filter((item) => !liveItems.some((liveItem) => liveItem.id === item.id)),
    ...liveItems,
  ];
  const preservedIds = new Set(preservedItems.map((item) => item.id));
  return {
    ...runtime,
    historyState: "loaded",
    historyBaseItems: [],
    items: [...historyItems.filter((item) => !preservedIds.has(item.id)), ...preservedItems],
    approvals: [],
  };
};

export const failSessionHistory = (runtime: AgentSessionRuntime): AgentSessionRuntime => ({
  ...runtime,
  historyState: "idle",
  historyBaseItems: [],
  items: withoutLoadingItems(runtime.items),
});
