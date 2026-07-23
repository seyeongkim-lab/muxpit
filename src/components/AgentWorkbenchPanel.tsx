import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import claudeIconUrl from "../assets/provider-claude.svg";
import codexIconUrl from "../assets/provider-codex.svg";
import { AcpClient, automaticPermissionOptionId } from "../agent/acpClient.ts";
import {
  claudePromptLine,
  createAgentImageAttachments,
  imageBlobsFromClipboard,
  promptTimelineText,
} from "../agent/agentImages.ts";
import {
  desktopAgentChannelId,
  newDesktopAgentChannelNamespace,
} from "../agent/desktopAgentChannels.ts";
import {
  buildDesktopSessionIndex,
  desktopSessionKey,
  type DesktopSessionEntry,
} from "../agent/desktopUnifiedSessions.ts";
import {
  desktopLegacySnapshotKeys,
  loadDesktopWorkbenchSelection,
  saveDesktopWorkbenchSelection,
} from "../agent/desktopWorkbenchPersistence.ts";
import {
  closeDesktopAgent,
  deleteDesktopSessionGoal,
  listDesktopClaudeSessions,
  listDesktopSessionGoals,
  listDesktopSessionSettings,
  loadDesktopClaudeSession,
  onDesktopAgentTransport,
  openDesktopAgent,
  probeDesktopAgents,
  setDesktopSessionGoal,
  setDesktopSessionSetting,
  writeDesktopAgentLine,
  type DesktopAgentTarget,
} from "../agent/desktopAgentBridge.ts";
import { useWorkspaceInfoStore } from "../hooks/useWorkspaceInfo.ts";
import {
  ClaudeStreamNormalizer,
  JsonLineDecoder,
  claudeInterruptLine,
  composerAction,
  encodeSessionGoal,
  encodeSessionSettings,
  isSessionActive,
  markSessionActivity,
  mergeAgentSessions,
  normalizeClaudeHistoryMessage,
  parseSessionGoalsMessage,
  parseSessionSettingsMessage,
  reconcileAgentSessions,
  sessionGoalKey,
  type MobileAgentEvent,
  type MobileSession,
  type MobileTimelineItem,
  type SessionGoal,
  type SessionSettings,
} from "../mobile/agentProtocol.ts";
import {
  beginSessionHistory,
  completeSessionHistory,
  createSessionRuntime,
  failSessionHistory,
  moveSessionRuntime,
  readSessionRuntime,
  retryBackoffMs,
  runningSessionIds,
  sessionRuntimeLabel,
  sessionRuntimeKey,
  shouldProcessAgentChannelPayload,
  updateSessionRuntime,
  type AgentApprovalRequest,
  type AgentChannelPurpose,
  type AgentExecutionSettings,
  type AgentSessionRuntime,
  type AgentSessionRuntimes,
} from "../mobile/agentSessionRuntime.ts";
import {
  loadAgentWorkbenchSnapshot,
  saveAgentWorkbenchSnapshot,
  type AgentWorkbenchViewSnapshot,
} from "../mobile/agentWorkbenchPersistence.ts";
import { CodexMobileClient, type CodexModelOption } from "../mobile/codexMobileClient.ts";
import { AI_KINDS } from "../stores/aiCli.ts";
import { useFileViewerStore } from "../stores/fileViewer.ts";
import { buildSshConnection, useSshHostsStore } from "../stores/sshHosts.ts";
import { useWorkspaceStore, type AiKind } from "../stores/workspace.ts";
import { collectOrderedLeaves } from "../utils/layoutGeometry.ts";
import { parseSshCommandLine } from "../utils/sshConnection.ts";
import {
  buildWorkbenchPaneSpec,
  pickWorkbenchFocusLeaf,
  type WorkbenchLeafCandidate,
} from "../utils/workbenchFocus.ts";
import { AgentImageAttachments } from "./AgentImageAttachments.tsx";
import { MarkdownContent, ThinkingOutput, ToolCallContent, ToolOutput } from "./AgentMessageContent.tsx";
import "./AgentWorkbenchPanel.css";

interface AgentWorkbenchPanelProps {
  open: boolean;
  onClose: () => void;
  /** Terminal area content docked below the AI composer while the panel is open. */
  dock?: React.ReactNode;
}

interface ProviderView {
  sessions: MobileSession[];
  activeSessionId: string | null;
  closedSessionIds: string[];
  runtimes: AgentSessionRuntimes;
  error: string | null;
  status: "idle" | "connecting" | "ready";
}

interface ChannelMeta {
  provider: AiKind;
  purpose: AgentChannelPurpose;
  handledPayload: boolean;
  sessionId?: string;
  launchSettings?: AgentExecutionSettings;
}

interface DesktopTargetDescriptor {
  key: string;
  label: string;
  target: DesktopAgentTarget;
  legacyStorageKeys: string[];
  legacyStoragePrefixes: string[];
  workspaceId?: string;
  leafId?: string;
}

interface DesktopTargetSnapshot {
  views: Record<AiKind, ProviderView>;
  installed: Set<AiKind>;
  probed: boolean;
  probing: boolean;
  provider: AiKind;
  goals: Record<string, SessionGoal>;
}

interface DesktopTargetSelection {
  nonce: number;
  targetKey: string;
  provider: AiKind;
  sessionId: string | null;
  create: boolean;
}

interface DesktopTargetCommand {
  nonce: number;
  targetKey: string;
  provider: AiKind;
  sessionId: string;
  action: "stop" | "close" | "restore";
}

interface DesktopTargetRuntimeProps {
  active: boolean;
  command?: DesktopTargetCommand;
  discover: boolean;
  selection?: DesktopTargetSelection;
  target: DesktopTargetDescriptor;
  onSnapshot: (targetKey: string, snapshot: DesktopTargetSnapshot) => void;
}

const MIN_WORKBENCH_WIDTH = 420;
const MIN_TERMINAL_WIDTH = 280;
const SESSION_COLUMN_WIDTH_KEY = "muxpit-workbench-session-width";
const MIN_SESSION_COLUMN_WIDTH = 150;
const MAX_SESSION_COLUMN_WIDTH = 460;
const TERMINAL_DOCK_HEIGHT_KEY = "muxpit-workbench-dock-height";
const MIN_TERMINAL_DOCK_HEIGHT = 80;

const clampedStoredPx = (key: string, fallback: number, min: number, max: number): number => {
  const stored = Number.parseInt(localStorage.getItem(key) ?? "", 10);
  return Number.isFinite(stored) ? Math.min(max, Math.max(min, stored)) : fallback;
};
const CLAUDE_HELPER_TIMEOUT_MS = 30_000;
const DESKTOP_WORKBENCH_STORAGE_PREFIX = "muxpit-desktop-agent-workbench-v2:";
const LEGACY_DESKTOP_WORKBENCH_STORAGE_PREFIX = "muxpit-desktop-agent-workbench-v1:";
const WORKBENCH_PERSIST_DELAY_MS = 200;
const SESSION_REFRESH_INTERVAL_MS = 5_000;
const PROBE_RETRY_BASE_MS = 5_000;
const PROBE_RETRY_MAX_MS = 60_000;
const LIST_RETRY_MAX_MS = 60_000;
const TIMELINE_PIN_THRESHOLD_PX = 48;
const COMPOSER_MAX_HEIGHT_PX = 148;
const CLAUDE_INTERRUPT_FALLBACK_MS = 2_500;
const CLAUDE_MODELS = ["opus", "sonnet", "fable"] as const;
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const PROVIDER_NAMES: Record<AiKind, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  copilot: "Copilot",
  opencode: "OpenCode",
};

const PROVIDER_MARKS: Record<AiKind, string> = {
  claude: "CL",
  codex: "CX",
  gemini: "GM",
  copilot: "CP",
  opencode: "OC",
};

const PROVIDER_ICON_URLS: Partial<Record<AiKind, string>> = {
  claude: claudeIconUrl,
  codex: codexIconUrl,
};

const ProviderMark = ({ provider }: { provider: AiKind }) => {
  const iconUrl = PROVIDER_ICON_URLS[provider];
  return (
    <span className="agent-session-provider-mark" aria-label={PROVIDER_NAMES[provider]}>
      {iconUrl
        ? <img src={iconUrl} className={`agent-provider-icon ${provider}`} alt="" />
        : PROVIDER_MARKS[provider]}
    </span>
  );
};

let workbenchPaneCounter = 0;
const nextWorkbenchPaneId = (): string =>
  `agent-pane-${Date.now()}-${workbenchPaneCounter++}`;

// Memoized so streaming deltas only re-render the row that changed, keeping
// long conversations smooth while text pours in.
const TimelineRow = memo(({ item, providerName, streaming, onOpenFile }: {
  item: MobileTimelineItem;
  providerName: string;
  streaming: boolean;
  onOpenFile?: (path: string) => void;
}) => (
  <article className={`agent-timeline-row ${item.kind}${streaming ? " streaming" : ""}`}>
    <div>
      <small>
        {item.kind === "user"
          ? "You"
          : item.kind === "assistant"
            ? providerName
            : item.kind === "thinking"
              ? "Thinking"
              : item.title ?? "Status"}
      </small>
      {item.kind === "tool"
        ? item.tool
          ? <ToolCallContent tool={item.tool} fallbackText={item.text} />
          : <ToolOutput text={item.text} />
        : item.kind === "assistant"
          ? <MarkdownContent text={item.text} onOpenFile={onOpenFile} highlightCode />
          : item.kind === "thinking"
            ? <ThinkingOutput text={item.text} />
            : <p>{item.text}</p>}
    </div>
  </article>
));

const emptyView = (): ProviderView => ({
  sessions: [],
  activeSessionId: null,
  closedSessionIds: [],
  runtimes: {},
  error: null,
  status: "idle",
});

const emptyViews = (): Record<AiKind, ProviderView> => ({
  claude: emptyView(),
  codex: emptyView(),
  gemini: emptyView(),
  copilot: emptyView(),
  opencode: emptyView(),
});

const snapshotViews = (
  views: Record<AiKind, ProviderView>,
): Record<AiKind, AgentWorkbenchViewSnapshot> => Object.fromEntries(
  AI_KINDS.map((kind) => [kind, {
    sessions: views[kind].sessions,
    activeSessionId: views[kind].activeSessionId,
    closedSessionIds: views[kind].closedSessionIds,
    runtimes: views[kind].runtimes,
  }]),
) as Record<AiKind, AgentWorkbenchViewSnapshot>;

// Model ids can carry a decoration suffix like "claude-fable-5[1m]" (context
// size marker in settings.json); labels drop it.
const stripModelDecoration = (value: string): string => value.replace(/\[[^\]]*\]$/, "");

const relativeTime = (timestamp?: number): string => {
  if (!timestamp) return "";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

const appendItem = (
  items: MobileTimelineItem[],
  item: MobileTimelineItem,
): MobileTimelineItem[] => {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  return items.map((candidate, candidateIndex) => candidateIndex === index ? item : candidate);
};

const appendDelta = (
  items: MobileTimelineItem[],
  id: string,
  text: string,
  kind: "user" | "assistant" | "thinking" = "assistant",
): MobileTimelineItem[] => {
  const item = items.find((candidate) => candidate.id === id);
  return item
    ? items.map((candidate) => candidate.id === id
        ? { ...candidate, text: candidate.text + text }
        : candidate)
    : [...items, { id, kind, text }];
};

const providerChannelKey = (kind: AiKind, sessionId?: string | null): string =>
  kind === "claude" ? `${kind}:${sessionRuntimeKey(sessionId)}` : kind;

const resolvedExecutionSettings = (
  requested: AgentExecutionSettings,
  effective: AgentExecutionSettings,
): AgentExecutionSettings => ({
  model: requested.model ?? effective.model,
  effort: requested.effort ?? effective.effort,
  serviceTier: requested.serviceTier ?? effective.serviceTier,
});

const sameClaudeLaunchSettings = (
  left: AgentExecutionSettings | undefined,
  right: AgentExecutionSettings,
): boolean => left?.model === right.model && left.effort === right.effort;

const stoppedRuntimes = (runtimes: AgentSessionRuntimes): AgentSessionRuntimes =>
  Object.fromEntries(Object.entries(runtimes).map(([key, runtime]) => [key, {
    ...runtime,
    activeTurnId: null,
    connectionState: "disconnected",
    running: false,
    waiting: false,
  }]));

const targetContextKey = (target: DesktopAgentTarget): string => {
  const connection = target.sshConnection ?? parseSshCommandLine(target.sshCommand)?.connection;
  if (connection) {
    return `ssh:${connection.program}:${connection.target}:${connection.options.join("\u0000")}`;
  }
  return target.sshCommand ? `ssh-command:${target.sshCommand}` : "local";
};

const loadTargetSnapshot = (
  target: DesktopTargetDescriptor,
): Pick<DesktopTargetSnapshot, "provider" | "views"> => {
  const current = loadAgentWorkbenchSnapshot(
    `${DESKTOP_WORKBENCH_STORAGE_PREFIX}${target.key}`,
    AI_KINDS,
  );
  const legacyStorageKeys = [...new Set([
    ...target.legacyStorageKeys.map((key) => `${LEGACY_DESKTOP_WORKBENCH_STORAGE_PREFIX}${key}`),
    ...desktopLegacySnapshotKeys(localStorage, target.legacyStoragePrefixes),
  ])];
  const legacy = legacyStorageKeys.flatMap((storageKey) => {
    const snapshot = loadAgentWorkbenchSnapshot(
      storageKey,
      AI_KINDS,
    );
    return snapshot ? [snapshot] : [];
  });
  const snapshots = [...legacy, ...(current ? [current] : [])];
  const views = emptyViews();
  for (const snapshot of snapshots) {
    for (const kind of AI_KINDS) {
      const restored = snapshot.views[kind];
      if (!restored) continue;
      const sessions = new Map(views[kind].sessions.map((session) => [session.id, session]));
      for (const session of restored.sessions) sessions.set(session.id, session);
      views[kind] = {
        ...views[kind],
        sessions: mergeAgentSessions([], [...sessions.values()]),
        activeSessionId: restored.activeSessionId ?? views[kind].activeSessionId,
        closedSessionIds: [...new Set([
          ...views[kind].closedSessionIds,
          ...(restored.closedSessionIds ?? []),
        ])],
        runtimes: { ...views[kind].runtimes, ...restored.runtimes },
      };
    }
  }
  const orderedLegacy = [...legacy].sort((left, right) => {
    const updatedAt = (snapshot: typeof left): number => {
      const view = snapshot.views[snapshot.provider];
      return view?.sessions.find((session) => session.id === view.activeSessionId)?.updatedAt ?? 0;
    };
    return updatedAt(left) - updatedAt(right);
  });
  const preferred = current ?? orderedLegacy[orderedLegacy.length - 1];
  if (preferred) {
    const activeSessionId = preferred.views[preferred.provider]?.activeSessionId;
    if (activeSessionId) views[preferred.provider].activeSessionId = activeSessionId;
  }
  return {
    provider: preferred?.provider ?? "codex",
    views,
  };
};

const DesktopTargetRuntime = ({
  active,
  command,
  discover,
  selection,
  target: targetDescriptor,
  onSnapshot,
}: DesktopTargetRuntimeProps) => {
  const initialSnapshot = useRef(loadTargetSnapshot(targetDescriptor));
  const restoredSelection = selection?.targetKey === targetDescriptor.key ? selection : undefined;
  const initialProvider = restoredSelection?.provider ?? initialSnapshot.current.provider;
  const [provider, setProvider] = useState<AiKind>(initialProvider);
  const [installed, setInstalled] = useState<Set<AiKind>>(new Set());
  const [probedTarget, setProbedTarget] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeAttempt, setProbeAttempt] = useState(0);
  const [codexModels, setCodexModels] = useState<CodexModelOption[]>([]);
  // The host CLI's own defaults (~/.claude/settings.json model/effortLevel),
  // reported with every session list; labels the "Default" choice.
  const [claudeCliDefaults, setClaudeCliDefaults] = useState<{
    model: string | null;
    effort: string | null;
  }>({ model: null, effort: null });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [goals, setGoals] = useState<Record<string, SessionGoal>>({});
  const [goalDraft, setGoalDraft] = useState<string | null>(null);
  const [views, setViews] = useState<Record<AiKind, ProviderView>>(() => {
    if (!restoredSelection?.sessionId) return initialSnapshot.current.views;
    return {
      ...initialSnapshot.current.views,
      [restoredSelection.provider]: {
        ...initialSnapshot.current.views[restoredSelection.provider],
        activeSessionId: restoredSelection.sessionId,
      },
    };
  });
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const timelinePinned = useRef(true);
  const timelineSessionRef = useRef<string | null>(null);
  const viewsRef = useRef(views);
  const providerRef = useRef(provider);
  const channels = useRef(new Map<string, ChannelMeta>());
  const providerChannels = useRef(new Map<string, string>());
  const openingProviders = useRef(new Map<string, Promise<string | undefined>>());
  const decoders = useRef(new Map<string, JsonLineDecoder>());
  const claudeNormalizers = useRef(new Map<string, ClaudeStreamNormalizer>());
  const codexClients = useRef(new Map<AiKind, CodexMobileClient>());
  const acpClients = useRef(new Map<AiKind, AcpClient>());
  const expectedClose = useRef(new Set<string>());
  const stderr = useRef(new Map<string, string>());
  const helperTimeouts = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingInterrupts = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const refreshingProviders = useRef(new Set<AiKind>());
  // Consecutive session-list failures per provider. Drives capped exponential
  // backoff so a slow host isn't hammered with a fresh ssh exec every 5s.
  const listFailures = useRef(new Map<AiKind, number>());
  const nextListRefresh = useRef(new Map<AiKind, number>());
  // Last host-synced per-session execution settings, keyed by sessionGoalKey.
  const hostSessionSettings = useRef<Record<string, SessionSettings>>({});
  const channelNamespace = useRef(newDesktopAgentChannelNamespace());
  const channelSequence = useRef(0);
  const runtimeGeneration = useRef(0);
  const submitRef = useRef<(
    provider: AiKind,
    sessionId: string | null,
    text: string,
    queued?: boolean,
  ) => Promise<boolean>>(async () => false);
  const queuedDispatches = useRef(new Set<string>());
  const handledSelection = useRef(0);
  const handledCommand = useRef(0);
  const discoveredProviders = useRef(new Set<AiKind>());
  const target = targetDescriptor.target;
  const targetKey = targetDescriptor.key;
  const view = views[provider];
  const runtime = readSessionRuntime(view.runtimes, view.activeSessionId);
  const latestTimelineTextLength = runtime.items[runtime.items.length - 1]?.text.length ?? 0;
  providerRef.current = provider;

  const updateView = useCallback((kind: AiKind, update: (current: ProviderView) => ProviderView) => {
    const current = viewsRef.current;
    const next = { ...current, [kind]: update(current[kind]) };
    viewsRef.current = next;
    setViews(next);
  }, []);

  const updateRuntime = useCallback((
    kind: AiKind,
    sessionId: string | null | undefined,
    update: (current: AgentSessionRuntime) => AgentSessionRuntime,
  ): void => {
    updateView(kind, (current) => ({
      ...current,
      runtimes: updateSessionRuntime(current.runtimes, sessionId, update),
    }));
  }, [updateView]);

  const nextChannelId = useCallback((kind: AiKind, purpose: ChannelMeta["purpose"]): string => {
    channelSequence.current += 1;
    return desktopAgentChannelId(
      channelNamespace.current,
      kind,
      purpose,
      Date.now(),
      channelSequence.current,
    );
  }, []);

  const closeChannel = useCallback(async (channelId: string): Promise<void> => {
    const timeout = helperTimeouts.current.get(channelId);
    if (timeout) clearTimeout(timeout);
    helperTimeouts.current.delete(channelId);
    const interruptFallback = pendingInterrupts.current.get(channelId);
    if (interruptFallback) clearTimeout(interruptFallback);
    pendingInterrupts.current.delete(channelId);
    expectedClose.current.add(channelId);
    await closeDesktopAgent(channelId).catch(() => {});
    channels.current.delete(channelId);
    decoders.current.delete(channelId);
    claudeNormalizers.current.delete(channelId);
  }, []);

  const applyEvent = useCallback((kind: AiKind, event: MobileAgentEvent): void => {
    switch (event.type) {
      case "sessionsLoaded":
        updateView(kind, (current) => ({
          ...current,
          sessions: reconcileAgentSessions(
            markSessionActivity(event.sessions, Date.now()),
            current.sessions,
            [current.activeSessionId, ...runningSessionIds(current.runtimes)],
          ),
          status: "ready",
        }));
        return;
      case "sessionLoaded":
        updateView(kind, (current) => ({
          ...current,
          runtimes: updateSessionRuntime(
            current.runtimes,
            event.session.id,
            (runtime) => completeSessionHistory(runtime, event.items),
          ),
          sessions: [
            ...markSessionActivity([event.session], Date.now()),
            ...current.sessions.filter((session) => session.id !== event.session.id),
          ],
          status: "ready",
        }));
        return;
      case "sessionStatus":
        updateRuntime(kind, event.sessionId, (current) => ({
          ...current,
          activeTurnId: event.running
            ? event.turnId ?? current.activeTurnId
            : null,
          running: event.running,
          waiting: event.waiting,
        }));
        return;
      case "turnStarted":
        updateView(kind, (current) => ({
          ...current,
          sessions: current.sessions.map((session) => session.id === event.sessionId
            ? { ...session, updatedAt: Math.floor(Date.now() / 1000) }
            : session),
        }));
        updateRuntime(kind, event.sessionId, (current) => ({
          ...current,
          activeTurnId: event.turnId,
          running: true,
          waiting: false,
        }));
        return;
      case "turnCompleted": {
        const sessionRuntime = readSessionRuntime(
          viewsRef.current[kind].runtimes,
          event.sessionId,
        );
        const next = sessionRuntime.queue[0];
        updateRuntime(kind, event.sessionId, (current) => ({
          ...current,
          activeTurnId: null,
          running: false,
          waiting: false,
        }));
        if (next) {
          const dispatchKey = `${kind}:${event.sessionId}`;
          if (!queuedDispatches.current.has(dispatchKey)) {
            queuedDispatches.current.add(dispatchKey);
            setTimeout(() => {
              void (async () => {
                try {
                  const sent = await submitRef.current(kind, event.sessionId, next, true);
                  if (sent) {
                    updateRuntime(kind, event.sessionId, (current) => ({
                      ...current,
                      queue: current.queue[0] === next ? current.queue.slice(1) : current.queue,
                    }));
                  }
                } finally {
                  queuedDispatches.current.delete(dispatchKey);
                }
              })();
            }, 0);
          }
        }
        return;
      }
      case "messageDelta":
        updateRuntime(kind, event.sessionId, (current) => ({
          ...current,
          items: appendDelta(current.items, event.itemId, event.text),
        }));
        return;
      case "userMessage":
        updateRuntime(kind, event.sessionId, (current) => ({
          ...current,
          items: appendDelta(current.items, event.itemId, event.text, "user"),
        }));
        return;
      case "messageCompleted":
        updateRuntime(kind, event.sessionId, (current) => ({
          ...current,
          items: appendItem(current.items, {
            id: event.itemId ?? `assistant-${Date.now()}-${current.items.length}`,
            kind: "assistant",
            text: event.text,
          }),
        }));
        return;
      case "toolStarted":
        updateRuntime(kind, event.sessionId, (current) => ({
          ...current,
          items: appendItem(current.items, {
            id: event.itemId,
            kind: "tool",
            title: event.title,
            text: event.detail,
            ...(event.tool ? { tool: event.tool } : {}),
          }),
        }));
        return;
      case "toolResult":
        // Nest the result under its originating call; a result that arrives
        // for an unknown call still surfaces as its own row.
        updateRuntime(kind, event.sessionId, (current) => ({
          ...current,
          items: current.items.some((item) => item.id === event.itemId)
            ? current.items.map((item) => item.id === event.itemId
                ? {
                    ...item,
                    tool: {
                      ...(item.tool ?? { name: item.title ?? "Tool" }),
                      resultText: event.text,
                      ...(event.isError ? { resultError: true } : {}),
                    },
                  }
                : item)
            : appendItem(current.items, {
                id: `${event.itemId}-result`,
                kind: "tool",
                title: "Tool result",
                text: event.text,
              }),
        }));
        return;
      case "thinking":
        updateRuntime(kind, event.sessionId, (current) => ({
          ...current,
          items: appendItem(current.items, {
            id: event.itemId,
            kind: "thinking",
            text: event.text,
          }),
        }));
        return;
      case "thinkingDelta":
        updateRuntime(kind, event.sessionId, (current) => ({
          ...current,
          items: appendDelta(current.items, event.itemId, event.text, "thinking"),
        }));
        return;
      case "approvalRequested": {
        const request = kind === "codex"
          ? codexClients.current.get(kind)?.resolveApproval(event.requestId, true)
          : kind !== "claude"
            ? (() => {
                const optionId = automaticPermissionOptionId(event.options);
                return optionId
                  ? acpClients.current.get(kind)?.resolvePermission(event.requestId, optionId)
                  : undefined;
              })()
            : undefined;
        if (request) {
          void request.catch((reason) => {
            updateView(kind, (current) => ({ ...current, error: String(reason) }));
          });
          return;
        }
        updateRuntime(kind, event.sessionId, (current) => ({
          ...current,
          approvals: [
            ...current.approvals.filter((approval) => approval.requestId !== event.requestId),
            {
              requestId: event.requestId,
              title: event.title,
              detail: event.detail,
              options: event.options,
            },
          ],
        }));
        return;
      }
      case "error":
        updateView(kind, (current) => ({
          ...current,
          runtimes: updateSessionRuntime(
            current.runtimes,
            event.sessionId ?? current.activeSessionId,
            failSessionHistory,
          ),
          status: "ready",
          error: event.message,
        }));
    }
  }, [updateRuntime, updateView]);

  const recordListFailure = useCallback((kind: AiKind): void => {
    const failures = (listFailures.current.get(kind) ?? 0) + 1;
    listFailures.current.set(kind, failures);
    nextListRefresh.current.set(
      kind,
      Date.now() + retryBackoffMs(failures, SESSION_REFRESH_INTERVAL_MS, LIST_RETRY_MAX_MS),
    );
  }, []);

  const clearListFailures = useCallback((kind: AiKind): void => {
    listFailures.current.delete(kind);
    nextListRefresh.current.delete(kind);
  }, []);

  const openClaudeAux = useCallback(async (
    purpose: "claude-list" | "claude-history",
    sessionId?: string,
  ): Promise<void> => {
    if (purpose === "claude-list") {
      updateView("claude", (current) => ({ ...current, status: "connecting", error: null }));
    }
    const channelId = nextChannelId("claude", purpose);
    channels.current.set(channelId, {
      provider: "claude",
      purpose,
      handledPayload: false,
      ...(sessionId ? { sessionId } : {}),
    });
    decoders.current.set(channelId, new JsonLineDecoder());
    helperTimeouts.current.set(channelId, setTimeout(() => {
      const meta = channels.current.get(channelId);
      if (!meta || meta.handledPayload) return;
      meta.handledPayload = true;
      if (purpose === "claude-list") recordListFailure("claude");
      updateView("claude", (current) => ({
        ...current,
        runtimes: purpose === "claude-history"
          ? updateSessionRuntime(current.runtimes, sessionId, failSessionHistory)
          : current.runtimes,
        status: "ready",
        error: purpose === "claude-history"
          ? "Claude session history timed out"
          : "Claude session list timed out",
      }));
      void closeChannel(channelId);
    }, CLAUDE_HELPER_TIMEOUT_MS));
    try {
      const session = sessionId
        ? viewsRef.current.claude.sessions.find((candidate) => candidate.id === sessionId)
        : undefined;
      const sessionTarget = session?.cwd ? { ...target, cwd: session.cwd } : target;
      if (sessionId) await loadDesktopClaudeSession(channelId, sessionId, sessionTarget);
      else await listDesktopClaudeSessions(channelId, target);
    } catch (reason) {
      channels.current.delete(channelId);
      decoders.current.delete(channelId);
      const timeout = helperTimeouts.current.get(channelId);
      if (timeout) clearTimeout(timeout);
      helperTimeouts.current.delete(channelId);
      if (purpose === "claude-list") recordListFailure("claude");
      updateView("claude", (current) => ({
        ...current,
        runtimes: updateSessionRuntime(
          current.runtimes,
          sessionId ?? current.activeSessionId,
          failSessionHistory,
        ),
        status: "ready",
        error: String(reason),
      }));
    }
  }, [closeChannel, nextChannelId, recordListFailure, target, updateView]);

  // Session goals live on the host, so a lightweight helper channel fetches
  // and mutates them; the helper echoes the full goal map back on every call.
  const openGoalsChannel = useCallback(async (
    start: (channelId: string) => Promise<void>,
  ): Promise<void> => {
    const channelId = nextChannelId("claude", "goals");
    channels.current.set(channelId, { provider: "claude", purpose: "goals", handledPayload: false });
    decoders.current.set(channelId, new JsonLineDecoder());
    try {
      await start(channelId);
    } catch (reason) {
      channels.current.delete(channelId);
      decoders.current.delete(channelId);
      updateView("claude", (current) => ({ ...current, error: String(reason) }));
    }
  }, [nextChannelId, updateView]);

  const refreshGoals = useCallback((): Promise<void> =>
    openGoalsChannel((channelId) => listDesktopSessionGoals(channelId, target)),
  [openGoalsChannel, target]);

  const refreshSessionSettings = useCallback((): Promise<void> =>
    openGoalsChannel((channelId) => listDesktopSessionSettings(channelId, target)),
  [openGoalsChannel, target]);

  // Store the host settings map and seed runtimes that never chose settings
  // locally, so a session loaded on this surface shows the model/effort it
  // was last driven with anywhere.
  const applySessionSettings = useCallback((incoming: Record<string, SessionSettings>): void => {
    hostSessionSettings.current = incoming;
    for (const kind of AI_KINDS) {
      updateView(kind, (current) => {
        let runtimes = current.runtimes;
        for (const session of current.sessions) {
          const hostSettings = incoming[sessionGoalKey(kind, session.id)];
          if (!hostSettings) continue;
          const local = readSessionRuntime(runtimes, session.id).executionSettings;
          if (local.model !== null || local.effort !== null || local.serviceTier !== null) continue;
          runtimes = updateSessionRuntime(runtimes, session.id, (runtime) => ({
            ...runtime,
            executionSettings: {
              model: hostSettings.model,
              effort: hostSettings.effort,
              serviceTier: hostSettings.serviceTier,
            },
          }));
        }
        return runtimes === current.runtimes ? current : { ...current, runtimes };
      });
    }
  }, [updateView]);

  const pushSessionSettings = useCallback((
    kind: AiKind,
    sessionId: string,
    settings: AgentExecutionSettings,
  ): Promise<void> => openGoalsChannel((channelId) => setDesktopSessionSetting(
    channelId,
    sessionGoalKey(kind, sessionId),
    encodeSessionSettings({
      model: settings.model ?? null,
      effort: settings.effort ?? null,
      serviceTier: settings.serviceTier ?? null,
      updatedAt: Math.floor(Date.now() / 1000),
    }),
    target,
  )), [openGoalsChannel, target]);

  const requestGoalChange = useCallback((key: string, goal: SessionGoal | null): Promise<void> =>
    openGoalsChannel((channelId) => goal
      ? setDesktopSessionGoal(channelId, key, encodeSessionGoal(goal), target)
      : deleteDesktopSessionGoal(channelId, key, target)),
  [openGoalsChannel, target]);

  const openProvider = useCallback((kind: AiKind, sessionId?: string): Promise<string | undefined> => {
    const key = providerChannelKey(kind, sessionId);
    const currentChannel = providerChannels.current.get(key);
    if (currentChannel) {
      updateRuntime(kind, sessionId ?? viewsRef.current[kind].activeSessionId, (runtime) => ({
        ...runtime,
        connectionState: "connected",
      }));
      return Promise.resolve(currentChannel);
    }
    const existing = openingProviders.current.get(key);
    if (existing) return existing;
    const generation = runtimeGeneration.current;
    let opening!: Promise<string | undefined>;
    opening = (async () => {
      const channelId = nextChannelId(kind, "provider");
      const activeSessionId = sessionId ?? viewsRef.current[kind].activeSessionId;
      const activeSession = viewsRef.current[kind].sessions.find(
        (candidate) => candidate.id === activeSessionId,
      );
      const sessionTarget = activeSession?.cwd ? { ...target, cwd: activeSession.cwd } : target;
      const launchRuntime = readSessionRuntime(
        viewsRef.current[kind].runtimes,
        activeSessionId,
      );
      channels.current.set(channelId, {
        provider: kind,
        purpose: "provider",
        handledPayload: false,
        ...(sessionId ? { sessionId } : {}),
        ...(kind === "claude" ? { launchSettings: launchRuntime.executionSettings } : {}),
      });
      decoders.current.set(channelId, new JsonLineDecoder());
      if (kind === "claude") {
        claudeNormalizers.current.set(channelId, new ClaudeStreamNormalizer());
      }
      updateView(kind, (current) => ({ ...current, status: "connecting", error: null }));
      try {
        await openDesktopAgent(
          channelId,
          kind,
          sessionTarget,
          kind === "claude" ? sessionId : undefined,
          launchRuntime.executionSettings,
        );
        if (generation !== runtimeGeneration.current || !channels.current.has(channelId)) {
          await closeChannel(channelId);
          return undefined;
        }
        providerChannels.current.set(key, channelId);
        if (kind === "codex") {
          const client = new CodexMobileClient(
            (line) => writeDesktopAgentLine(channelId, line),
            (event) => applyEvent(kind, event),
          );
          codexClients.current.set(kind, client);
          await client.connect();
          void client.listSessions().catch((reason) => {
            updateView(kind, (current) => ({ ...current, error: String(reason) }));
          });
          void client.listModels().then(setCodexModels).catch(() => setCodexModels([]));
          const resumedSessionId = activeSessionId ?? undefined;
          if (resumedSessionId) {
            try {
              const settings = await client.resumeSession(resumedSessionId);
              updateRuntime(kind, resumedSessionId, (runtime) => ({
                ...runtime,
                executionSettings: resolvedExecutionSettings(
                  runtime.executionSettings,
                  settings,
                ),
              }));
            } catch (reason) {
              updateView(kind, (current) => ({ ...current, error: String(reason) }));
            }
          }
        } else if (kind === "claude") {
          updateView(kind, (current) => ({ ...current, status: "ready" }));
          const current = viewsRef.current.claude;
          const shouldLoadData = sessionId
            ? readSessionRuntime(current.runtimes, sessionId).historyState !== "loaded"
            : current.sessions.length === 0;
          if (shouldLoadData) {
            await openClaudeAux(sessionId ? "claude-history" : "claude-list", sessionId);
          }
        } else {
          const client = new AcpClient(
            kind,
            (line) => writeDesktopAgentLine(channelId, line),
            (event) => applyEvent(kind, event),
          );
          acpClients.current.set(kind, client);
          await client.initialize();
          const resumedSessionId = activeSessionId ?? undefined;
          if (resumedSessionId) {
            const activeSession = viewsRef.current[kind].sessions.find(
              (candidate) => candidate.id === resumedSessionId,
            );
            try {
              await client.loadSession(resumedSessionId, activeSession?.cwd ?? target.cwd ?? ".");
              updateRuntime(kind, resumedSessionId, (runtime) => completeSessionHistory(runtime, []));
            } catch (reason) {
              // Leave "loading" (e.g. the provider cannot replay saved
              // sessions) or the timeline sticks on the placeholder and the
              // composer stays blocked.
              updateView(kind, (current) => ({
                ...current,
                runtimes: updateSessionRuntime(current.runtimes, resumedSessionId, failSessionHistory),
                error: String(reason),
              }));
            }
          }
          updateView(kind, (current) => ({ ...current, status: "ready" }));
        }
        updateRuntime(kind, activeSessionId, (runtime) => ({
          ...runtime,
          connectionState: "connected",
        }));
        return channelId;
      } catch (reason) {
        updateView(kind, (current) => ({
          ...current,
          runtimes: updateSessionRuntime(
            current.runtimes,
            sessionId ?? current.activeSessionId,
            (runtime) => ({
              ...failSessionHistory(runtime),
              connectionState: "disconnected",
            }),
          ),
          status: "idle",
          error: String(reason),
        }));
        providerChannels.current.delete(key);
        codexClients.current.get(kind)?.close();
        acpClients.current.get(kind)?.close();
        codexClients.current.delete(kind);
        acpClients.current.delete(kind);
        await closeChannel(channelId);
        return undefined;
      } finally {
        if (openingProviders.current.get(key) === opening) {
          openingProviders.current.delete(key);
        }
      }
    })();
    openingProviders.current.set(key, opening);
    return opening;
  }, [applyEvent, closeChannel, nextChannelId, openClaudeAux, target, updateRuntime, updateView]);

  const refreshSessions = useCallback((): void => {
    if (document.visibilityState !== "visible") return;
    for (const kind of AI_KINDS) {
      if (!installed.has(kind) || refreshingProviders.current.has(kind)) continue;
      if (Date.now() < (nextListRefresh.current.get(kind) ?? 0)) continue;
      let request: Promise<void> | undefined;
      if (kind === "claude") {
        const alreadyListing = [...channels.current.values()].some(
          (meta) => meta.purpose === "claude-list",
        );
        if (!alreadyListing) request = openClaudeAux("claude-list");
      } else if (kind === "codex") {
        request = codexClients.current.get(kind)?.listSessions();
      } else {
        request = acpClients.current.get(kind)?.listSessions();
      }
      if (!request) continue;
      refreshingProviders.current.add(kind);
      void request
        .then(() => clearListFailures(kind), () => recordListFailure(kind))
        .finally(() => refreshingProviders.current.delete(kind));
    }
  }, [clearListFailures, installed, openClaudeAux, recordListFailure]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onDesktopAgentTransport((event) => {
      const meta = channels.current.get(event.channelId);
      if (!meta) return;
      if (event.kind === "stderr" && event.data?.trim()) {
        stderr.current.set(event.channelId, event.data.trim());
        return;
      }
      if (event.kind === "exit") {
        const expected = expectedClose.current.delete(event.channelId);
        if (!expected && event.exitStatus && event.exitStatus !== 0) {
          const detail = stderr.current.get(event.channelId);
          if (meta.purpose === "goals") {
            // Goal sync is best-effort; a failed helper never surfaces as a
            // conversation error.
            meta.handledPayload = true;
            return;
          }
          if (meta.purpose !== "provider") {
            meta.handledPayload = true;
            updateView("claude", (current) => ({
              ...current,
              runtimes: meta.purpose === "claude-history"
                ? updateSessionRuntime(current.runtimes, meta.sessionId, failSessionHistory)
                : current.runtimes,
              status: "ready",
              error: detail || `Claude helper exited with status ${event.exitStatus}`,
            }));
            return;
          }
          updateView(meta.provider, (current) => ({
            ...current,
            runtimes: meta.sessionId
              ? updateSessionRuntime(current.runtimes, meta.sessionId, (runtime) => ({
                  ...runtime,
                  activeTurnId: null,
                  connectionState: "disconnected",
                  running: false,
                  waiting: false,
                }))
              : stoppedRuntimes(current.runtimes),
            status: meta.provider === "claude" ? current.status : "idle",
            error: detail || `${PROVIDER_NAMES[meta.provider]} exited with status ${event.exitStatus}`,
          }));
        }
        return;
      }
      if (event.kind === "closed") {
        const timeout = helperTimeouts.current.get(event.channelId);
        if (timeout) clearTimeout(timeout);
        helperTimeouts.current.delete(event.channelId);
        if (meta.purpose !== "provider" && meta.purpose !== "goals" && !meta.handledPayload) {
          const detail = stderr.current.get(event.channelId);
          updateView("claude", (current) => ({
            ...current,
            runtimes: meta.purpose === "claude-history"
              ? updateSessionRuntime(
                  current.runtimes,
                  meta.sessionId ?? current.activeSessionId,
                  failSessionHistory,
                )
              : current.runtimes,
            status: "ready",
            error: detail || (meta.purpose === "claude-history"
              ? "Claude session history returned no data"
              : "Claude session list returned no data"),
          }));
        }
        channels.current.delete(event.channelId);
        decoders.current.delete(event.channelId);
        claudeNormalizers.current.delete(event.channelId);
        stderr.current.delete(event.channelId);
        const key = providerChannelKey(meta.provider, meta.sessionId);
        const ownsRuntime = providerChannels.current.get(key) === event.channelId;
        if (ownsRuntime) {
          providerChannels.current.delete(key);
        }
        if (meta.purpose === "provider" && meta.provider === "claude" && ownsRuntime) {
          updateRuntime("claude", meta.sessionId, (runtime) => ({
            ...runtime,
            activeTurnId: null,
            connectionState: "disconnected",
            running: false,
            waiting: false,
          }));
        } else if (meta.purpose === "provider" && ownsRuntime) {
          codexClients.current.get(meta.provider)?.close();
          acpClients.current.get(meta.provider)?.close();
          codexClients.current.delete(meta.provider);
          acpClients.current.delete(meta.provider);
          updateView(meta.provider, (current) => ({
            ...current,
            runtimes: stoppedRuntimes(current.runtimes),
          }));
        }
        return;
      }
      if (event.kind !== "stdout" || !event.data) return;
      const decoder = decoders.current.get(event.channelId) ?? new JsonLineDecoder();
      decoders.current.set(event.channelId, decoder);
      for (const line of decoder.push(event.data)) {
        if (!shouldProcessAgentChannelPayload(meta.purpose, meta.handledPayload)) break;
        if (meta.purpose === "provider" && meta.provider === "codex") {
          codexClients.current.get(meta.provider)?.receive(line);
          continue;
        }
        if (meta.purpose === "provider" && meta.provider !== "claude") {
          acpClients.current.get(meta.provider)?.receive(line);
          continue;
        }
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          const goalsUpdate = parseSessionGoalsMessage(message);
          if (goalsUpdate) {
            meta.handledPayload = true;
            setGoals(goalsUpdate);
            continue;
          }
          const settingsUpdate = parseSessionSettingsMessage(message);
          if (settingsUpdate) {
            meta.handledPayload = true;
            applySessionSettings(settingsUpdate);
            continue;
          }
          if (message.type === "muxpit_sessions" && Array.isArray(message.sessions)) {
            meta.handledPayload = true;
            const timeout = helperTimeouts.current.get(event.channelId);
            if (timeout) clearTimeout(timeout);
            helperTimeouts.current.delete(event.channelId);
            clearListFailures("claude");
            const defaults = message.defaults as { model?: unknown; effort?: unknown } | undefined;
            setClaudeCliDefaults({
              model: typeof defaults?.model === "string" && defaults.model ? defaults.model : null,
              effort: typeof defaults?.effort === "string" && defaults.effort ? defaults.effort : null,
            });
            applyEvent("claude", {
              type: "sessionsLoaded",
              sessions: message.sessions as MobileSession[],
            });
            continue;
          }
          const historyEvents = normalizeClaudeHistoryMessage(message, meta.sessionId);
          const normalizer = claudeNormalizers.current.get(event.channelId);
          const normalized = historyEvents.length > 0
            ? historyEvents
            : normalizer?.receive(message) ?? [];
          if (normalized.some((item) => item.type === "turnCompleted")) {
            // The interrupt was honored; keep the channel open for reuse.
            const interruptFallback = pendingInterrupts.current.get(event.channelId);
            if (interruptFallback) clearTimeout(interruptFallback);
            pendingInterrupts.current.delete(event.channelId);
          }
          if (normalized.length > 0) meta.handledPayload = true;
          if (normalized.length > 0 && meta.purpose !== "provider") {
            const timeout = helperTimeouts.current.get(event.channelId);
            if (timeout) clearTimeout(timeout);
            helperTimeouts.current.delete(event.channelId);
          }
          for (const item of normalized) {
            const eventSessionId = item.type === "sessionLoaded"
              ? item.session.id
              : "sessionId" in item
                ? item.sessionId
                : undefined;
            if (
              meta.purpose === "provider"
              && eventSessionId
              && eventSessionId !== meta.sessionId
            ) {
              const previousId = meta.sessionId;
              const previousKey = providerChannelKey("claude", previousId);
              if (providerChannels.current.get(previousKey) === event.channelId) {
                providerChannels.current.delete(previousKey);
              }
              providerChannels.current.set(providerChannelKey("claude", eventSessionId), event.channelId);
              meta.sessionId = eventSessionId;
              updateView("claude", (current) => {
                const runtimes = moveSessionRuntime(current.runtimes, previousId, eventSessionId);
                // List the session as soon as its id is known; the periodic
                // claude-list refresh fills in the authoritative title/cwd once
                // the session file lands on the host.
                const firstUserText = readSessionRuntime(runtimes, eventSessionId)
                  .items.find((item) => item.kind === "user")?.text ?? "";
                return {
                  ...current,
                  activeSessionId: current.activeSessionId === (previousId ?? null)
                    ? eventSessionId
                    : current.activeSessionId,
                  runtimes,
                  sessions: current.sessions.some((session) => session.id === eventSessionId)
                    ? current.sessions
                    : [{
                        id: eventSessionId,
                        title: firstUserText.slice(0, 80) || "Claude session",
                        updatedAt: Math.floor(Date.now() / 1000),
                        provider: "claude" as const,
                      }, ...current.sessions],
                };
              });
            }
            applyEvent("claude", item);
          }
        } catch {
          meta.handledPayload = true;
          if (meta.purpose !== "provider") {
            const timeout = helperTimeouts.current.get(event.channelId);
            if (timeout) clearTimeout(timeout);
            helperTimeouts.current.delete(event.channelId);
            void closeChannel(event.channelId);
          }
          updateView(meta.provider, (current) => ({
            ...current,
            runtimes: meta.purpose === "claude-history"
              ? updateSessionRuntime(
                  current.runtimes,
                  meta.sessionId ?? current.activeSessionId,
                  failSessionHistory,
                )
              : current.runtimes,
            error: `${PROVIDER_NAMES[meta.provider]} returned an invalid JSON line`,
          }));
        }
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyEvent, applySessionSettings, clearListFailures, updateRuntime, updateView]);

  useEffect(() => () => {
    runtimeGeneration.current += 1;
    for (const client of codexClients.current.values()) client.close("Target removed");
    for (const client of acpClients.current.values()) client.close("Target removed");
    for (const channelId of channels.current.keys()) void closeDesktopAgent(channelId);
  }, []);

  useEffect(() => {
    if (!discover || probedTarget === targetKey) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setProbing(true);
    void probeDesktopAgents(AI_KINDS, target)
      .then((found) => {
        if (cancelled) return;
        setInstalled(found);
        setProbedTarget(targetKey);
        if (!found.has(providerRef.current)) {
          setProvider(AI_KINDS.find((kind) => found.has(kind)) ?? "codex");
        }
      })
      .catch((reason) => {
        if (cancelled) return;
        updateView(providerRef.current, (current) => ({ ...current, error: String(reason) }));
        // A slow or flaky link must not disable the target until restart:
        // schedule another probe with capped exponential backoff.
        retryTimer = setTimeout(
          () => setProbeAttempt((attempt) => attempt + 1),
          retryBackoffMs(probeAttempt + 1, PROBE_RETRY_BASE_MS, PROBE_RETRY_MAX_MS),
        );
      })
      .finally(() => {
        if (!cancelled) setProbing(false);
      });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [discover, probeAttempt, probedTarget, target, targetKey, updateView]);

  const persistWorkbench = useCallback((): void => {
    if (probedTarget !== targetKey) return;
    saveAgentWorkbenchSnapshot(`${DESKTOP_WORKBENCH_STORAGE_PREFIX}${targetKey}`, {
      provider: providerRef.current,
      views: snapshotViews(viewsRef.current),
    });
  }, [probedTarget, targetKey]);

  useEffect(() => {
    const timeout = setTimeout(persistWorkbench, WORKBENCH_PERSIST_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [persistWorkbench, provider, views]);

  useEffect(() => {
    const persistWhenHidden = (): void => {
      if (document.visibilityState === "hidden") {
        persistWorkbench();
        return;
      }
      if (document.visibilityState === "visible" && discover && probedTarget === targetKey) {
        void refreshSessions();
        // Pick up goal and settings changes made from other devices while
        // we were hidden.
        void refreshGoals();
        void refreshSessionSettings();
        for (const kind of AI_KINDS) {
          if (!installed.has(kind)) continue;
          const sessionId = viewsRef.current[kind].activeSessionId ?? undefined;
          if (kind === "claude" && !sessionId) {
            void openClaudeAux("claude-list");
            continue;
          }
          const channelKey = providerChannelKey(kind, sessionId);
          const sessionRuntime = readSessionRuntime(viewsRef.current[kind].runtimes, sessionId);
          if (
            sessionRuntime.connectionState === "disconnected"
            || !providerChannels.current.has(channelKey)
          ) {
            void openProvider(kind, kind === "claude" ? sessionId : undefined);
          }
        }
      }
    };
    document.addEventListener("visibilitychange", persistWhenHidden);
    window.addEventListener("beforeunload", persistWorkbench);
    return () => {
      document.removeEventListener("visibilitychange", persistWhenHidden);
      window.removeEventListener("beforeunload", persistWorkbench);
    };
  }, [discover, installed, openClaudeAux, openProvider, persistWorkbench, probedTarget, refreshGoals, refreshSessionSettings, refreshSessions, targetKey]);

  useEffect(() => {
    if (!discover || probedTarget !== targetKey) return;
    void refreshGoals();
    void refreshSessionSettings();
  }, [discover, probedTarget, refreshGoals, refreshSessionSettings, targetKey]);

  useEffect(() => {
    if (!discover || probedTarget !== targetKey) return;
    const refresh = (): void => {
      if (document.visibilityState === "visible") void refreshSessions();
    };
    const timer = window.setInterval(refresh, SESSION_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [discover, probedTarget, refreshSessions, targetKey]);

  useEffect(() => {
    if (!discover || probedTarget !== targetKey) return;
    for (const kind of AI_KINDS) {
      if (!installed.has(kind) || discoveredProviders.current.has(kind)) continue;
      discoveredProviders.current.add(kind);
      if (kind === "claude") {
        void openClaudeAux("claude-list");
        continue;
      }
      void openProvider(kind).then((channelId) => {
        if (!channelId) discoveredProviders.current.delete(kind);
      });
    }
  }, [discover, installed, openClaudeAux, openProvider, probedTarget, targetKey]);

  useEffect(() => {
    if (!active || probedTarget !== targetKey || !installed.has(provider)) return;
    if (provider === "claude") {
      const activeSessionId = viewsRef.current.claude.activeSessionId ?? undefined;
      const activeRuntime = readSessionRuntime(
        viewsRef.current.claude.runtimes,
        activeSessionId,
      );
      if (activeRuntime.connectionState === "disconnected") {
        void openProvider("claude", activeSessionId);
        return;
      }
      if (viewsRef.current.claude.status === "idle") {
        void openClaudeAux(activeSessionId ? "claude-history" : "claude-list", activeSessionId);
      }
      return;
    }
    void openProvider(provider);
  }, [
    active,
    installed,
    openClaudeAux,
    openProvider,
    probedTarget,
    provider,
    runtime.connectionState,
    targetKey,
  ]);

  // Keep the timeline glued to the newest output only while the user is at
  // (or near) the bottom. Scrolling up to read pauses auto-scroll; switching
  // provider or session re-pins so a freshly opened chat starts at the end.
  const timelineSessionKey = `${provider}:${sessionRuntimeKey(view.activeSessionId)}`;
  const handleTimelineScroll = useCallback((): void => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timelinePinned.current =
      timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < TIMELINE_PIN_THRESHOLD_PX;
  }, []);

  // File-looking inline code in the conversation opens the viewer drawer.
  // Relative paths resolve against the active session's cwd on this target;
  // `||` (not `??`) so an empty cwd falls through to the target's directory.
  const openFileFromTimeline = useCallback((path: string): void => {
    const view = viewsRef.current[providerRef.current];
    const session = view.sessions.find((candidate) => candidate.id === view.activeSessionId);
    useFileViewerStore.getState().openFile(path, {
      cwd: session?.cwd || target.cwd,
      sshCommand: target.sshCommand,
      sshConnection: target.sshConnection,
    });
  }, [target]);

  useLayoutEffect(() => {
    if (!active || !timelineRef.current) return;
    if (timelineSessionRef.current !== timelineSessionKey) {
      timelineSessionRef.current = timelineSessionKey;
      timelinePinned.current = true;
    }
    if (timelinePinned.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    }
  }, [
    latestTimelineTextLength,
    active,
    timelineSessionKey,
    runtime.approvals.length,
    runtime.items.length,
    runtime.running,
  ]);

  useLayoutEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;
    input.style.height = "0";
    input.style.height = `${Math.min(input.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
  }, [runtime.draft, timelineSessionKey]);

  const selectSession = async (kind: AiKind, session: MobileSession): Promise<void> => {
    const selectedRuntime = readSessionRuntime(viewsRef.current[kind].runtimes, session.id);
    // Seed host-synced settings before anything launches so the session opens
    // with the model/effort it was last driven with on any surface.
    const hostSettings = hostSessionSettings.current[sessionGoalKey(kind, session.id)];
    const localSettings = selectedRuntime.executionSettings;
    if (
      hostSettings
      && localSettings.model === null
      && localSettings.effort === null
      && localSettings.serviceTier === null
    ) {
      updateRuntime(kind, session.id, (runtime) => ({
        ...runtime,
        executionSettings: {
          model: hostSettings.model,
          effort: hostSettings.effort,
          serviceTier: hostSettings.serviceTier,
        },
      }));
    }
    const shouldReconnect = selectedRuntime.connectionState === "disconnected";
    const shouldLoadHistory = selectedRuntime.historyState === "idle";
    updateView(kind, (current) => ({
      ...current,
      activeSessionId: session.id,
      runtimes: updateSessionRuntime(
        current.runtimes,
        session.id,
        (runtime) => shouldLoadHistory ? beginSessionHistory(runtime, session.id) : runtime,
      ),
      error: null,
    }));
    try {
      const providerClientMissing = kind === "codex"
        ? !codexClients.current.has(kind)
        : kind !== "claude" && !acpClients.current.has(kind);
      if (shouldReconnect || providerClientMissing) {
        await openProvider(kind, kind === "claude" ? session.id : undefined);
        return;
      }
      if (kind === "codex") {
        if (shouldLoadHistory) {
          const settings = await codexClients.current.get(kind)?.resumeSession(session.id);
          if (settings) updateRuntime(kind, session.id, (runtime) => ({
            ...runtime,
            executionSettings: resolvedExecutionSettings(
              runtime.executionSettings,
              settings,
            ),
          }));
        }
      } else if (kind === "claude") {
        if (shouldLoadHistory) await openClaudeAux("claude-history", session.id);
      } else {
        if (shouldLoadHistory) {
          await acpClients.current.get(kind)?.loadSession(session.id, session.cwd ?? target.cwd ?? ".");
          // ACP replays history via session/update events; the resolved
          // session/load is the only completion signal, so mark the runtime
          // loaded here or it stays on "Loading session…" with the composer
          // blocked.
          updateRuntime(kind, session.id, (runtime) => completeSessionHistory(runtime, []));
        }
      }
    } catch (reason) {
      updateView(kind, (current) => ({
        ...current,
        runtimes: updateSessionRuntime(current.runtimes, session.id, failSessionHistory),
        error: String(reason),
      }));
    }
  };

  const newSession = async (kind: AiKind): Promise<void> => {
    updateView(kind, (current) => ({
      ...current,
      activeSessionId: null,
      runtimes: { ...current.runtimes, [sessionRuntimeKey(null)]: createSessionRuntime() },
      error: null,
    }));
    try {
      let sessionId: string | undefined;
      if (kind === "codex") {
        await openProvider(kind);
        const started = await codexClients.current.get(kind)?.startSession(
          target.cwd,
          readSessionRuntime(viewsRef.current[kind].runtimes, null).executionSettings,
        );
        sessionId = started?.threadId;
        if (sessionId && started) {
          updateRuntime(kind, null, (runtime) => ({
            ...runtime,
            executionSettings: resolvedExecutionSettings(
              runtime.executionSettings,
              started.settings,
            ),
          }));
        }
      } else if (kind === "claude") {
        await openProvider(kind);
      } else {
        await openProvider(kind);
        sessionId = await acpClients.current.get(kind)?.newSession(target.cwd ?? ".");
      }
      if (sessionId) {
        updateView(kind, (current) => ({
          ...current,
          activeSessionId: sessionId,
          runtimes: moveSessionRuntime(current.runtimes, null, sessionId),
        }));
      }
    } catch (reason) {
      updateView(kind, (current) => ({ ...current, error: String(reason) }));
    }
  };

  useEffect(() => {
    if (
      !active
      || !selection
      || selection.targetKey !== targetKey
      || handledSelection.current === selection.nonce
      || probedTarget !== targetKey
    ) return;
    handledSelection.current = selection.nonce;
    setProvider(selection.provider);
    if (!installed.has(selection.provider)) {
      updateView(selection.provider, (current) => ({
        ...current,
        error: `${PROVIDER_NAMES[selection.provider]} is not installed on ${targetDescriptor.label}`,
      }));
      return;
    }
    if (selection.create) {
      void newSession(selection.provider);
      return;
    }
    const session = viewsRef.current[selection.provider].sessions.find(
      (candidate) => candidate.id === selection.sessionId,
    );
    if (session) void selectSession(selection.provider, session);
  }, [active, installed, probedTarget, selection, targetDescriptor.label, targetKey, updateView]);

  const sendText = async (
    kind: AiKind,
    text: string,
    queued = false,
    requestedSessionId?: string | null,
  ): Promise<boolean> => {
    const trimmed = text.trim();
    const current = viewsRef.current[kind];
    let sessionId = requestedSessionId === undefined
      ? current.activeSessionId
      : requestedSessionId;
    let currentRuntime = readSessionRuntime(current.runtimes, sessionId);
    const attachments = queued ? [] : currentRuntime.attachments;
    if (!trimmed && attachments.length === 0) return false;
    const sessionCwd = current.sessions.find((session) => session.id === sessionId)?.cwd
      ?? target.cwd;
    if (currentRuntime.historyState === "loading") return false;
    const action = queued ? "send" : composerAction(currentRuntime.running, currentRuntime.queueMode);
    if (action === "queue") {
      if (attachments.length > 0) {
        updateView(kind, (state) => ({
          ...state,
          error: "Image attachments cannot be queued. Use Steer or wait for the current task.",
        }));
        return false;
      }
      updateRuntime(kind, sessionId, (runtime) => ({
        ...runtime,
        queue: [...runtime.queue, trimmed],
        draft: "",
      }));
      return true;
    }
    updateView(kind, (state) => ({ ...state, error: null }));
    const timelineText = promptTimelineText(trimmed, attachments);

    if (kind === "codex") {
      try {
        await openProvider(kind);
        const client = codexClients.current.get(kind);
        if (!client) throw new Error("Codex channel is not ready");
        if (!sessionId) {
          const started = await client.startSession(
            target.cwd,
            currentRuntime.executionSettings,
          );
          const createdSessionId = started.threadId;
          sessionId = createdSessionId;
          updateView(kind, (state) => ({
            ...state,
            activeSessionId: state.activeSessionId === null ? createdSessionId : state.activeSessionId,
            runtimes: moveSessionRuntime(state.runtimes, null, createdSessionId),
            sessions: state.sessions.some((session) => session.id === createdSessionId)
              ? state.sessions
              : [{
                  id: createdSessionId,
                  title: timelineText.slice(0, 80),
                  cwd: target.cwd,
                  updatedAt: Math.floor(Date.now() / 1000),
                  provider: kind,
                }, ...state.sessions],
          }));
          currentRuntime = readSessionRuntime(viewsRef.current[kind].runtimes, createdSessionId);
          updateRuntime(kind, createdSessionId, (runtime) => ({
            ...runtime,
            executionSettings: resolvedExecutionSettings(
              currentRuntime.executionSettings,
              started.settings,
            ),
          }));
          currentRuntime = readSessionRuntime(viewsRef.current[kind].runtimes, createdSessionId);
        }
        updateRuntime(kind, sessionId, (runtime) => ({
          ...runtime,
          draft: "",
          running: true,
          waiting: false,
          historyState: "loaded",
          items: [...runtime.items, { id: `user-${Date.now()}`, kind: "user", text: timelineText }],
        }));
        if (action === "steer" && currentRuntime.activeTurnId) {
          await client.steer(sessionId, currentRuntime.activeTurnId, trimmed, attachments);
        } else {
          await client.startTurn(
            sessionId,
            trimmed,
            sessionCwd,
            readSessionRuntime(viewsRef.current[kind].runtimes, sessionId).executionSettings,
            attachments,
          );
        }
        updateRuntime(kind, sessionId, (runtime) => ({ ...runtime, attachments: [] }));
        return true;
      } catch (reason) {
        if (action !== "steer") {
          updateRuntime(kind, sessionId, (runtime) => ({
            ...runtime,
            running: false,
            waiting: false,
          }));
        }
        updateView(kind, (state) => ({ ...state, error: String(reason) }));
        return false;
      }
    }

    if (kind === "claude") {
      let channelId = providerChannels.current.get(providerChannelKey(kind, sessionId));
      const channelMeta = channelId ? channels.current.get(channelId) : undefined;
      if (
        channelId
        && action === "send"
        && !sameClaudeLaunchSettings(channelMeta?.launchSettings, currentRuntime.executionSettings)
      ) {
        providerChannels.current.delete(providerChannelKey(kind, sessionId));
        await closeChannel(channelId).catch(() => {});
        channelId = await openProvider(kind, sessionId ?? undefined);
      }
      if (!channelId) channelId = await openProvider(kind, sessionId ?? undefined);
      if (!channelId) return false;
      updateRuntime(kind, sessionId, (runtime) => ({
        ...runtime,
        draft: "",
        running: true,
        waiting: false,
        historyState: "loaded",
        items: [...runtime.items, { id: `user-${Date.now()}`, kind: "user", text: timelineText }],
      }));
      try {
        await writeDesktopAgentLine(channelId, claudePromptLine(trimmed, attachments));
        updateRuntime(kind, sessionId, (runtime) => ({ ...runtime, attachments: [] }));
        return true;
      } catch (reason) {
        updateRuntime(kind, sessionId, (runtime) => ({
          ...runtime,
          running: false,
          waiting: false,
        }));
        updateView(kind, (state) => ({ ...state, error: String(reason) }));
        return false;
      }
    }

    try {
        await openProvider(kind);
        const client = acpClients.current.get(kind);
        if (!client) throw new Error(`${PROVIDER_NAMES[kind]} channel is not ready`);
        if (!sessionId) {
          const createdSessionId = await client.newSession(target.cwd ?? ".");
          sessionId = createdSessionId;
          updateView(kind, (state) => ({
            ...state,
            activeSessionId: state.activeSessionId === null ? createdSessionId : state.activeSessionId,
            runtimes: moveSessionRuntime(state.runtimes, null, createdSessionId),
            sessions: state.sessions.some((session) => session.id === createdSessionId)
              ? state.sessions
              : [{
                  id: createdSessionId,
                  title: timelineText.slice(0, 80),
                  cwd: target.cwd,
                  updatedAt: Math.floor(Date.now() / 1000),
                  provider: kind,
                }, ...state.sessions],
          }));
        }
        updateRuntime(kind, sessionId, (runtime) => ({
          ...runtime,
          draft: "",
          running: true,
          waiting: false,
          historyState: "loaded",
          items: [...runtime.items, { id: `user-${Date.now()}`, kind: "user", text: timelineText }],
        }));
        if (action === "steer") await client.cancel(sessionId);
        const stopReason = await client.prompt(sessionId, trimmed, attachments);
        updateRuntime(kind, sessionId, (runtime) => ({ ...runtime, attachments: [] }));
        applyEvent(kind, { type: "turnCompleted", sessionId, status: stopReason });
        return true;
    } catch (reason) {
      updateRuntime(kind, sessionId, (runtime) => ({ ...runtime, running: false, waiting: false }));
      updateView(kind, (state) => ({ ...state, error: String(reason) }));
      return false;
    }
  };
  submitRef.current = (kind, sessionId, text, queued) =>
    sendText(kind, text, queued, sessionId);

  const addComposerImages = async (
    kind: AiKind,
    sessionId: string | null,
    blobs: readonly Blob[],
  ): Promise<void> => {
    if (blobs.length === 0) return;
    const current = readSessionRuntime(viewsRef.current[kind].runtimes, sessionId);
    if (current.running && current.queueMode) {
      updateView(kind, (state) => ({
        ...state,
        error: "Image attachments cannot be queued. Switch to Steer first.",
      }));
      return;
    }
    try {
      const added = await createAgentImageAttachments(blobs, current.attachments);
      updateRuntime(kind, sessionId, (runtime) => ({
        ...runtime,
        attachments: [...runtime.attachments, ...added],
      }));
      updateView(kind, (state) => ({ ...state, error: null }));
    } catch (reason) {
      updateView(kind, (state) => ({ ...state, error: String(reason) }));
    }
  };

  const stopSession = useCallback(async (
    kind: AiKind,
    sessionId: string | null,
  ): Promise<void> => {
    const current = viewsRef.current[kind];
    const currentRuntime = readSessionRuntime(current.runtimes, sessionId);
    if (!currentRuntime.running && !currentRuntime.waiting) return;
    try {
      let claudeChannelClosed = false;
      if (kind === "codex" && sessionId && currentRuntime.activeTurnId) {
        await codexClients.current.get(kind)?.interrupt(sessionId, currentRuntime.activeTurnId);
      } else if (kind === "claude") {
        const key = providerChannelKey(kind, sessionId);
        const channelId = providerChannels.current.get(key);
        if (channelId) {
          // Ask the CLI to stop the turn in place so the session stays warm.
          // If the interrupt goes unanswered, fall back to closing the
          // channel like before; the next send reopens it with --resume.
          let interrupted = false;
          try {
            await writeDesktopAgentLine(channelId, claudeInterruptLine(`interrupt-${Date.now()}`));
            interrupted = true;
          } catch {}
          if (interrupted) {
            pendingInterrupts.current.set(channelId, setTimeout(() => {
              pendingInterrupts.current.delete(channelId);
              if (providerChannels.current.get(key) !== channelId) return;
              providerChannels.current.delete(key);
              void closeChannel(channelId);
              updateRuntime("claude", sessionId, (runtime) => ({
                ...runtime,
                connectionState: "idle",
              }));
            }, CLAUDE_INTERRUPT_FALLBACK_MS));
          } else {
            providerChannels.current.delete(key);
            await closeChannel(channelId);
            claudeChannelClosed = true;
          }
        }
      } else if (sessionId) {
        await acpClients.current.get(kind)?.cancel(sessionId);
      }
      updateRuntime(kind, sessionId, (runtime) => ({
        ...runtime,
        running: false,
        waiting: false,
        activeTurnId: null,
        connectionState: kind === "claude" && claudeChannelClosed ? "idle" : runtime.connectionState,
      }));
    } catch (reason) {
      updateView(kind, (state) => ({ ...state, error: String(reason) }));
    }
  }, [closeChannel, updateRuntime, updateView]);

  const stop = (): Promise<void> => stopSession(provider, viewsRef.current[provider].activeSessionId);

  useEffect(() => {
    if (
      !command
      || command.targetKey !== targetKey
      || handledCommand.current === command.nonce
    ) return;
    handledCommand.current = command.nonce;
    if (command.action === "stop") {
      void stopSession(command.provider, command.sessionId);
      return;
    }
    updateView(command.provider, (current) => {
      const closed = new Set(current.closedSessionIds);
      if (command.action === "close") closed.add(command.sessionId);
      else closed.delete(command.sessionId);
      const activeSessionId = command.action === "close"
        && current.activeSessionId === command.sessionId
        ? current.sessions.find((session) => !closed.has(session.id))?.id ?? null
        : current.activeSessionId;
      return {
        ...current,
        activeSessionId,
        closedSessionIds: [...closed],
      };
    });
  }, [command, stopSession, targetKey, updateView]);

  const resolveApproval = async (
    approval: AgentApprovalRequest,
    optionId?: string,
    accepted = false,
  ): Promise<void> => {
    try {
      if (provider === "codex") {
        await codexClients.current.get(provider)?.resolveApproval(approval.requestId, accepted);
      } else if (provider !== "claude") {
        await acpClients.current.get(provider)?.resolvePermission(approval.requestId, optionId);
      }
      updateRuntime(provider, view.activeSessionId, (current) => ({
        ...current,
        approvals: current.approvals.filter((item) => item.requestId !== approval.requestId),
      }));
    } catch (reason) {
      updateView(provider, (current) => ({ ...current, error: String(reason) }));
    }
  };

  const applyExecutionSettings = async (settings: AgentExecutionSettings): Promise<void> => {
    const kind = providerRef.current;
    const current = viewsRef.current[kind];
    const sessionId = current.activeSessionId;
    const previousSettings = readSessionRuntime(current.runtimes, sessionId).executionSettings;
    updateRuntime(kind, sessionId, (sessionRuntime) => ({
      ...sessionRuntime,
      executionSettings: settings,
    }));
    try {
      if (kind === "codex" && sessionId) {
        if (!codexClients.current.has(kind)) await openProvider(kind);
        const client = codexClients.current.get(kind);
        if (!client) throw new Error("Codex channel is not ready");
        await client.updateSessionSettings(sessionId, settings);
      }
      // Best-effort host sync so other surfaces load this session with the
      // same settings.
      if (sessionId) void pushSessionSettings(kind, sessionId, settings);
    } catch (reason) {
      updateRuntime(kind, sessionId, (sessionRuntime) => ({
        ...sessionRuntime,
        executionSettings: previousSettings,
      }));
      updateView(kind, (currentView) => ({ ...currentView, error: String(reason) }));
    }
  };

  useEffect(() => {
    onSnapshot(targetKey, {
      views,
      installed,
      probed: probedTarget === targetKey,
      probing,
      provider,
      goals,
    });
  }, [goals, installed, onSnapshot, probedTarget, probing, provider, targetKey, views]);

  const activeSession = view.sessions.find((session) => session.id === view.activeSessionId);
  const activeGoalKey = activeSession ? sessionGoalKey(provider, activeSession.id) : null;
  const activeGoal = activeGoalKey ? goals[activeGoalKey] : undefined;

  const saveGoal = (): void => {
    if (goalDraft === null || !activeGoalKey) return;
    const text = goalDraft.trim();
    setGoalDraft(null);
    if (!text) return;
    void requestGoalChange(activeGoalKey, {
      text,
      status: activeGoal?.status ?? "active",
      updatedAt: Math.floor(Date.now() / 1000),
    });
  };
  const supportsExecutionSettings = provider === "codex" || provider === "claude";
  const threadSettings = runtime.executionSettings;
  const selectedCodexModel = codexModels.find((model) =>
    model.model === threadSettings.model || model.id === threadSettings.model)
    ?? codexModels.find((model) => model.isDefault);
  const effortOptions = provider === "codex"
    ? selectedCodexModel?.supportedReasoningEfforts ?? []
    : [...CLAUDE_EFFORTS];
  const serviceTierOptions = selectedCodexModel?.serviceTiers ?? [];
  // A claude session without muxpit-chosen settings runs on the CLI's own
  // defaults; "Default" is labeled with what that actually is — the model the
  // transcript last recorded, else the host CLI default from settings.json.
  const activeClaudeSession = provider === "claude"
    ? view.sessions.find((session) => session.id === view.activeSessionId)
    : undefined;
  const claudeDefaultModel = activeClaudeSession?.model ?? claudeCliDefaults.model;
  const claudeModelDefaultLabel = claudeDefaultModel
    ? `Default (${stripModelDecoration(claudeDefaultModel)})`
    : "Default";
  const claudeEffortDefaultLabel = claudeCliDefaults.effort
    ? `Default (${claudeCliDefaults.effort})`
    : "Default";
  const modelLabel = provider === "codex"
    ? selectedCodexModel?.displayName ?? threadSettings.model ?? "Default"
    : threadSettings.model ?? claudeModelDefaultLabel;
  const effortLabel = threadSettings.effort
    ?? (provider === "claude"
      ? claudeEffortDefaultLabel
      : selectedCodexModel?.defaultReasoningEffort ?? "Default");
  const serviceTierLabel = serviceTierOptions.find((tier) => tier.id === threadSettings.serviceTier)?.name
    ?? threadSettings.serviceTier
    ?? "Standard";
  const executionSummaryLabel = [
    modelLabel,
    effortLabel,
    provider === "codex" ? serviceTierLabel : null,
  ].filter(Boolean).join(" · ");
  const hasCachedView = view.sessions.length > 0 || Object.keys(view.runtimes).length > 0;

  if (!active) return null;
  if (probing && probedTarget !== targetKey && !hasCachedView) {
    return <div className="agent-workbench-empty"><strong>Checking installed CLIs…</strong></div>;
  }
  if (probedTarget === targetKey && installed.size === 0) {
    return (
      <div className="agent-workbench-empty">
        <strong>No supported CLI found</strong>
        <p>Install a provider CLI on {target.sshConnection || target.sshCommand ? "the SSH host" : "this computer"}.</p>
      </div>
    );
  }

  return (
    <section className="agent-conversation">
            <header className="agent-conversation-header">
              <div className="agent-conversation-header-main">
                <div>
                  <span>{PROVIDER_NAMES[provider]}</span>
                  <strong>{activeSession?.title ?? "New session"}</strong>
                </div>
                <div className="agent-conversation-header-actions">
                  <span className={runtime.running ? "agent-run-state running" : "agent-run-state"}>
                    {view.status === "connecting" ? "Connecting" : sessionRuntimeLabel(runtime)}
                  </span>
                </div>
              </div>
              {activeSession ? (
                <div className="agent-goal-bar">
                  {goalDraft !== null ? (
                    <>
                      <input
                        value={goalDraft}
                        onChange={(event) => setGoalDraft(event.target.value)}
                        placeholder="Session goal"
                        aria-label="Session goal"
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing) return;
                          if (event.key === "Enter") saveGoal();
                          if (event.key === "Escape") setGoalDraft(null);
                        }}
                      />
                      <button type="button" onClick={saveGoal}>Save</button>
                      <button type="button" onClick={() => setGoalDraft(null)}>Cancel</button>
                    </>
                  ) : activeGoal ? (
                    <>
                      <button
                        type="button"
                        className={`agent-goal-status ${activeGoal.status}`}
                        title={activeGoal.status === "done" ? "Mark goal in progress" : "Mark goal done"}
                        onClick={() => activeGoalKey && void requestGoalChange(activeGoalKey, {
                          ...activeGoal,
                          status: activeGoal.status === "done" ? "active" : "done",
                          updatedAt: Math.floor(Date.now() / 1000),
                        })}
                      >{activeGoal.status === "done" ? "Done" : "In progress"}</button>
                      <span className="agent-goal-text">{activeGoal.text}</span>
                      <button type="button" onClick={() => setGoalDraft(activeGoal.text)}>Edit</button>
                      <button
                        type="button"
                        onClick={() => activeGoalKey && void requestGoalChange(activeGoalKey, null)}
                      >Delete</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setGoalDraft("")}>Set goal</button>
                  )}
                </div>
              ) : null}
            </header>

            <div ref={timelineRef} className="agent-timeline" aria-live="polite" onScroll={handleTimelineScroll}>
              {view.error ? (
                <div className="agent-inline-error" role="alert">
                  <span>{view.error}</span>
                  <button type="button" onClick={() => updateView(provider, (current) => ({ ...current, error: null }))}>Dismiss</button>
                </div>
              ) : null}
              {runtime.items.length === 0 && runtime.approvals.length === 0 ? (
                runtime.historyState === "loading" ? (
                  <div className="agent-timeline-empty">
                    <strong>Loading session history…</strong>
                  </div>
                ) : (
                  <div className="agent-timeline-empty">
                    <strong>Send the next instruction</strong>
                    <p>Messages and tool activity appear here. The provider terminal stays hidden.</p>
                  </div>
                )
              ) : null}
              {runtime.items.map((item, index) => (
                <TimelineRow
                  key={item.id}
                  item={item}
                  providerName={PROVIDER_NAMES[provider]}
                  streaming={runtime.running
                    && index === runtime.items.length - 1
                    && item.kind === "assistant"}
                  onOpenFile={openFileFromTimeline}
                />
              ))}
              {runtime.approvals.map((approval) => (
                <article key={approval.requestId} className="agent-approval">
                  <small>Approval required</small>
                  <strong>{approval.title}</strong>
                  {approval.detail ? <pre>{approval.detail}</pre> : null}
                  <div>
                    {approval.options?.length ? approval.options.map((option) => (
                      <button
                        type="button"
                        key={option.id}
                        className={option.kind.startsWith("allow") ? "approve" : "deny"}
                        onClick={() => void resolveApproval(approval, option.id)}
                      >{option.label}</button>
                    )) : (
                      <>
                        <button type="button" className="deny" onClick={() => void resolveApproval(approval, undefined, false)}>Deny</button>
                        <button type="button" className="approve" onClick={() => void resolveApproval(approval, undefined, true)}>Approve once</button>
                      </>
                    )}
                  </div>
                </article>
              ))}
              {runtime.running ? (
                <div className="agent-working">
                  <span /><span /><span />
                  {runtime.connectionState === "disconnected" ? "Connection paused · checking task" : "Working"}
                </div>
              ) : null}
            </div>

            {runtime.queue.length > 0 ? (
              <div className="agent-queue-preview">
                <span>{runtime.queue.length} queued</span>
                <p>{runtime.queue[0]}</p>
                <button type="button" onClick={() => updateRuntime(provider, view.activeSessionId, (current) => ({ ...current, queue: [] }))}>Clear</button>
              </div>
            ) : null}

            <footer className={runtime.running && !runtime.queueMode ? "agent-composer steering" : "agent-composer"}>
              <div className="agent-composer-surface">
              {settingsOpen && supportsExecutionSettings ? (
                <div className="agent-execution-settings">
                  <label>
                    <span>Model</span>
                    <select
                      value={threadSettings.model ?? ""}
                      disabled={provider === "claude" && runtime.running}
                      onChange={(event) => {
                        const model = event.target.value || null;
                        if (provider !== "codex") {
                          void applyExecutionSettings({ ...threadSettings, model });
                          return;
                        }
                        const option = codexModels.find((candidate) =>
                          candidate.model === model || candidate.id === model);
                        const effort = option?.supportedReasoningEfforts.includes(threadSettings.effort ?? "")
                          ? threadSettings.effort
                          : option?.defaultReasoningEffort ?? null;
                        const serviceTier = option?.serviceTiers.some((tier) => tier.id === threadSettings.serviceTier)
                          ? threadSettings.serviceTier
                          : option?.defaultServiceTier ?? null;
                        void applyExecutionSettings({ model, effort, serviceTier });
                      }}
                    >
                      <option value="">{provider === "claude" ? claudeModelDefaultLabel : "Default"}</option>
                      {provider === "codex"
                        ? codexModels.map((model) => (
                            <option key={model.id} value={model.model}>{model.displayName}</option>
                          ))
                        : <>
                            {threadSettings.model && !CLAUDE_MODELS.includes(threadSettings.model as typeof CLAUDE_MODELS[number])
                              ? <option value={threadSettings.model}>{threadSettings.model}</option>
                              : null}
                            {CLAUDE_MODELS.map((model) => <option key={model} value={model}>{model}</option>)}
                          </>}
                    </select>
                  </label>
                  <label>
                    <span>Effort</span>
                    <select
                      value={threadSettings.effort ?? ""}
                      disabled={provider === "claude" && runtime.running}
                      onChange={(event) => void applyExecutionSettings({
                        ...threadSettings,
                        effort: event.target.value || null,
                      })}
                    >
                      <option value="">{provider === "claude" ? claudeEffortDefaultLabel : "Default"}</option>
                      {threadSettings.effort && !effortOptions.includes(threadSettings.effort)
                        ? <option value={threadSettings.effort}>{threadSettings.effort}</option>
                        : null}
                      {effortOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                    </select>
                  </label>
                  {provider === "codex" ? (
                    <label>
                      <span>Speed</span>
                      <select
                        value={threadSettings.serviceTier ?? ""}
                        onChange={(event) => void applyExecutionSettings({
                          ...threadSettings,
                          serviceTier: event.target.value || null,
                        })}
                      >
                        <option value="">Standard</option>
                        {threadSettings.serviceTier && !serviceTierOptions.some((tier) => tier.id === threadSettings.serviceTier)
                          ? <option value={threadSettings.serviceTier}>{threadSettings.serviceTier}</option>
                          : null}
                        {serviceTierOptions.map((tier) => (
                          <option key={tier.id} value={tier.id}>{tier.name}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
              ) : null}
              <textarea
                ref={composerInputRef}
                value={runtime.draft}
                onChange={(event) => updateRuntime(provider, view.activeSessionId, (current) => ({
                  ...current,
                  draft: event.target.value,
                }))}
                onPaste={(event) => void addComposerImages(
                  provider,
                  view.activeSessionId,
                  (() => {
                    const images = imageBlobsFromClipboard(event.clipboardData);
                    if (images.length > 0) event.preventDefault();
                    return images;
                  })(),
                )}
                onKeyDown={(event) => {
                  // Never treat Enter as send while an IME (e.g. Hangul) is
                  // still composing — that Enter commits the composition.
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendText(provider, runtime.draft);
                    return;
                  }
                  if (event.key === "Escape" && runtime.running) {
                    event.preventDefault();
                    void stop();
                  }
                }}
                placeholder={runtime.running && !runtime.queueMode ? "Redirect the active task…" : runtime.running ? "Add the next instruction…" : "Message the agent…"}
                rows={1}
              />
              <div className="agent-composer-actions">
                <div>
                  <AgentImageAttachments
                    attachments={runtime.attachments}
                    disabled={runtime.running && runtime.queueMode}
                    onFiles={(files) => addComposerImages(provider, view.activeSessionId, files)}
                    onRemove={(id) => updateRuntime(provider, view.activeSessionId, (current) => ({
                      ...current,
                      attachments: current.attachments.filter((attachment) => attachment.id !== id),
                    }))}
                  />
                  {supportsExecutionSettings ? (
                    <button
                      type="button"
                      className="agent-execution-summary"
                      aria-expanded={settingsOpen}
                      onClick={() => setSettingsOpen((current) => !current)}
                    >{executionSummaryLabel}</button>
                  ) : null}
                  {runtime.running ? (
                    <>
                      <button type="button" className={!runtime.queueMode ? "active" : ""} onClick={() => updateRuntime(provider, view.activeSessionId, (current) => ({ ...current, queueMode: false }))}>Steer</button>
                      <button type="button" className={runtime.queueMode ? "active" : ""} onClick={() => updateRuntime(provider, view.activeSessionId, (current) => ({ ...current, queueMode: true }))}>Queue</button>
                    </>
                  ) : supportsExecutionSettings ? null : <span>Enter to send · Shift+Enter for a new line</span>}
                </div>
                <div>
                  {runtime.running ? <button type="button" className="agent-stop-button" title="Stop the current task (Esc)" onClick={() => void stop()}>Stop</button> : null}
                  <button
                    type="button"
                    className="agent-send-button"
                    disabled={
                      (!runtime.draft.trim() && runtime.attachments.length === 0)
                      || runtime.historyState === "loading"
                      || (provider === "codex" && runtime.running && !runtime.activeTurnId && !runtime.queueMode)
                    }
                    onClick={() => void sendText(provider, runtime.draft)}
                  >
                    {runtime.running ? runtime.queueMode ? "Queue" : "Steer" : "Send"}
                  </button>
                </div>
              </div>
              </div>
            </footer>
    </section>
  );
};

export const AgentWorkbenchPanel = ({ open, onClose, dock }: AgentWorkbenchPanelProps) => {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeId = useWorkspaceStore((state) => state.activeId);
  const leafCwds = useWorkspaceInfoStore((state) => state.leafCwds);
  const workspaceInfo = useWorkspaceInfoStore((state) => state.info);
  const sshHosts = useSshHostsStore((state) => state.hosts);
  const initialSelection = useRef(loadDesktopWorkbenchSelection(localStorage, AI_KINDS));
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(
    initialSelection.current?.targetKey ?? null,
  );
  const [targetSnapshots, setTargetSnapshots] = useState<Record<string, DesktopTargetSnapshot>>({});
  const [command, setCommand] = useState<DesktopTargetCommand>();
  const [selection, setSelection] = useState<DesktopTargetSelection | undefined>(() =>
    initialSelection.current ? {
      nonce: 1,
      ...initialSelection.current,
      create: false,
    } : undefined);
  const [sessionSearch, setSessionSearch] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionContext, setNewSessionContext] = useState("");
  const [newSessionProvider, setNewSessionProvider] = useState<AiKind>("codex");
  const [width, setWidth] = useState(620);
  const [sessionWidth, setSessionWidth] = useState(() =>
    clampedStoredPx(SESSION_COLUMN_WIDTH_KEY, 210, MIN_SESSION_COLUMN_WIDTH, MAX_SESSION_COLUMN_WIDTH));
  const [dockHeight, setDockHeight] = useState(() =>
    clampedStoredPx(TERMINAL_DOCK_HEIGHT_KEY, 280, MIN_TERMINAL_DOCK_HEIGHT, window.innerHeight));
  useEffect(() => {
    localStorage.setItem(SESSION_COLUMN_WIDTH_KEY, String(sessionWidth));
  }, [sessionWidth]);
  useEffect(() => {
    localStorage.setItem(TERMINAL_DOCK_HEIGHT_KEY, String(dockHeight));
  }, [dockHeight]);
  const selectionSequence = useRef(initialSelection.current ? 1 : 0);
  const commandSequence = useRef(0);

  const { targets, focusLeaves } = useMemo(() => {
    const contexts = new Map<string, DesktopTargetDescriptor>();
    const leaves: WorkbenchLeafCandidate[] = [];
    const savedHostNames = new Map(
      sshHosts.map((host) => [buildSshConnection(host).target, host.name]),
    );
    for (const workspace of workspaces) {
      for (const node of collectOrderedLeaves(workspace.layout)) {
        if (node.type !== "leaf") continue;
        const parsedSsh = parseSshCommandLine(node.sshCommand ?? node.command);
        const cwd = leafCwds[workspace.id]?.[node.id]
          ?? node.lastCwd
          ?? workspaceInfo[workspace.id]?.cwd
          ?? undefined;
        const target: DesktopAgentTarget = {
          cwd,
          sshCommand: node.sshCommand ?? (parsedSsh ? node.command : undefined),
          sshConnection: node.sshConnection ?? parsedSsh?.connection,
        };
        const key = targetContextKey(target);
        const connectionTarget = target.sshConnection?.target
          ?? parseSshCommandLine(target.sshCommand)?.connection.target;
        const label = connectionTarget
          ? savedHostNames.get(connectionTarget) ?? connectionTarget
          : "Local";
        const legacyKey = `${connectionTarget ?? target.sshCommand ?? "local"}|${cwd ?? ""}`;
        const legacyPrefix = `${connectionTarget ?? target.sshCommand ?? "local"}|`;
        const focused = workspace.id === activeId && workspace.focusedLeafId === node.id;
        leaves.push({
          workspaceId: workspace.id,
          leafId: node.id,
          contextKey: key,
          cwd,
          focused,
        });
        const current = contexts.get(key);
        if (!current) {
          contexts.set(key, {
            key,
            label,
            target,
            legacyStorageKeys: [legacyKey],
            legacyStoragePrefixes: [legacyPrefix],
            workspaceId: workspace.id,
            leafId: node.id,
          });
          continue;
        }
        if (!current.legacyStorageKeys.includes(legacyKey)) {
          current.legacyStorageKeys.push(legacyKey);
        }
        if (!current.legacyStoragePrefixes.includes(legacyPrefix)) {
          current.legacyStoragePrefixes.push(legacyPrefix);
        }
        if (focused) {
          contexts.set(key, {
            ...current,
            target,
            workspaceId: workspace.id,
            leafId: node.id,
          });
        }
      }
    }
    for (const host of sshHosts) {
      const connection = buildSshConnection(host);
      const target: DesktopAgentTarget = { sshConnection: connection };
      const key = targetContextKey(target);
      const legacyKey = `${connection.target}|`;
      const current = contexts.get(key);
      if (current) {
        current.label = host.name;
        if (!current.legacyStorageKeys.includes(legacyKey)) {
          current.legacyStorageKeys.push(legacyKey);
        }
        if (!current.legacyStoragePrefixes.includes(legacyKey)) {
          current.legacyStoragePrefixes.push(legacyKey);
        }
      } else {
        contexts.set(key, {
          key,
          label: host.name,
          target,
          legacyStorageKeys: [legacyKey],
          legacyStoragePrefixes: [legacyKey],
        });
      }
    }
    if (!contexts.has("local")) {
      contexts.set("local", {
        key: "local",
        label: "Local",
        target: {},
        legacyStorageKeys: ["local|"],
        legacyStoragePrefixes: ["local|"],
      });
    }
    return { targets: [...contexts.values()], focusLeaves: leaves };
  }, [activeId, leafCwds, sshHosts, workspaceInfo, workspaces]);

  const focusedTarget = targets.find((target) => {
    const workspace = workspaces.find((candidate) => candidate.id === target.workspaceId);
    return workspace?.id === activeId && workspace.focusedLeafId === target.leafId;
  });
  const activeTargetKey = targets.some((target) => target.key === selectedTargetKey)
    ? selectedTargetKey as string
    : focusedTarget?.key ?? targets[0]?.key ?? "local";

  const updateTargetSnapshot = useCallback((
    targetKey: string,
    snapshot: DesktopTargetSnapshot,
  ): void => {
    setTargetSnapshots((current) => {
      const previous = current[targetKey];
      if (
        previous?.views === snapshot.views
        && previous.installed === snapshot.installed
        && previous.probed === snapshot.probed
        && previous.probing === snapshot.probing
        && previous.provider === snapshot.provider
        && previous.goals === snapshot.goals
      ) return current;
      return { ...current, [targetKey]: snapshot };
    });
  }, []);

  const sessions = useMemo(() => buildDesktopSessionIndex(targets.flatMap((target) => {
    const snapshot = targetSnapshots[target.key];
    return snapshot ? [{
      contextKey: target.key,
      contextLabel: target.label,
      views: snapshotViews(snapshot.views),
    }] : [];
  })), [targetSnapshots, targets]);
  const openSessions = sessions.filter((entry) => !entry.closed);
  const closedSessions = sessions.filter((entry) => entry.closed);
  const listedSessions = showClosed ? closedSessions : openSessions;
  const filteredSessions = listedSessions.filter((entry) => {
    const search = sessionSearch.trim().toLowerCase();
    return !search || `${entry.session.title} ${entry.session.cwd ?? ""} ${entry.contextLabel} ${PROVIDER_NAMES[entry.provider]}`
      .toLowerCase()
      .includes(search);
  });
  const activeSnapshot = targetSnapshots[activeTargetKey];
  const activeProvider = activeSnapshot?.provider ?? "codex";
  const activeSessionId = activeSnapshot?.views[activeProvider].activeSessionId ?? null;
  const activeSessionKey = activeSessionId
    ? `${activeTargetKey}:${activeProvider}:${activeSessionId}`
    : null;

  useEffect(() => {
    if (!activeSnapshot?.probed) return;
    saveDesktopWorkbenchSelection(localStorage, {
      targetKey: activeTargetKey,
      provider: activeProvider,
      sessionId: activeSessionId,
    });
  }, [activeProvider, activeSessionId, activeSnapshot?.probed, activeTargetKey]);

  const focusTarget = useCallback((targetKey: string, sessionCwd?: string): void => {
    const leaf = pickWorkbenchFocusLeaf(focusLeaves, targetKey, sessionCwd);
    const target = targets.find((candidate) => candidate.key === targetKey);
    const workspaceId = leaf?.workspaceId ?? target?.workspaceId;
    const leafId = leaf?.leafId ?? target?.leafId;
    const store = useWorkspaceStore.getState();
    if (workspaceId && leafId) {
      store.setActive(workspaceId);
      store.setFocusedLeaf(workspaceId, leafId);
      return;
    }
    if (!target) return;
    // The session's host has no open pane; open one so the terminal side
    // always follows the selection.
    const spec = buildWorkbenchPaneSpec(target.label, target.target, sessionCwd);
    const paneId = nextWorkbenchPaneId();
    store.addWorkspaceWithLayout(spec.name, {
      type: "leaf",
      id: paneId,
      ptyId: null,
      command: spec.command,
      sshConnection: spec.sshConnection,
      sshRemoteCommand: spec.sshRemoteCommand,
      launchCwd: spec.launchCwd,
    }, paneId);
  }, [focusLeaves, targets]);

  const requestSelection = useCallback((
    targetKey: string,
    provider: AiKind,
    sessionId: string | null,
    create: boolean,
    sessionCwd?: string,
  ): void => {
    selectionSequence.current += 1;
    setSelectedTargetKey(targetKey);
    setSelection({
      nonce: selectionSequence.current,
      targetKey,
      provider,
      sessionId,
      create,
    });
    focusTarget(targetKey, sessionCwd);
  }, [focusTarget]);

  const requestCommand = useCallback((
    entry: DesktopSessionEntry,
    action: DesktopTargetCommand["action"],
  ): void => {
    if (action === "restore") setShowClosed(false);
    commandSequence.current += 1;
    setCommand({
      nonce: commandSequence.current,
      targetKey: entry.contextKey,
      provider: entry.provider,
      sessionId: entry.session.id,
      action,
    });
  }, []);

  const selectUnifiedSession = useCallback((entry: DesktopSessionEntry): void => {
    if (entry.closed) requestCommand(entry, "restore");
    requestSelection(entry.contextKey, entry.provider, entry.session.id, false, entry.session.cwd);
  }, [requestCommand, requestSelection]);

  const showNewSession = (): void => {
    setNewSessionContext(activeTargetKey);
    setNewSessionProvider(activeProvider);
    setNewSessionOpen((current) => !current);
  };

  const createUnifiedSession = (): void => {
    const targetKey = newSessionContext || activeTargetKey;
    requestSelection(targetKey, newSessionProvider, null, true);
    setNewSessionOpen(false);
  };

  const startResize = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent: MouseEvent) => {
      const maxWidth = Math.max(MIN_WORKBENCH_WIDTH, window.innerWidth - MIN_TERMINAL_WIDTH);
      setWidth(Math.min(maxWidth, Math.max(MIN_WORKBENCH_WIDTH, startWidth + startX - moveEvent.clientX)));
    };
    const stopResize = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stopResize);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stopResize);
  };

  const startSessionResize = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sessionWidth;
    const move = (moveEvent: MouseEvent) => {
      setSessionWidth(Math.min(
        MAX_SESSION_COLUMN_WIDTH,
        Math.max(MIN_SESSION_COLUMN_WIDTH, startWidth + moveEvent.clientX - startX),
      ));
    };
    const stopResize = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stopResize);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stopResize);
  };

  const startDockResize = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = dockHeight;
    const move = (moveEvent: MouseEvent) => {
      const maxHeight = Math.max(MIN_TERMINAL_DOCK_HEIGHT, Math.round(window.innerHeight * 0.75));
      setDockHeight(Math.min(
        maxHeight,
        Math.max(MIN_TERMINAL_DOCK_HEIGHT, startHeight + startY - moveEvent.clientY),
      ));
    };
    const stopResize = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stopResize);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stopResize);
  };

  // While the terminal is docked the panel owns the full area right of the
  // sidebar, so the side resizer is pointless and the width style must yield.
  const docked = Boolean(dock);
  return (
    <aside
      className="agent-workbench"
      style={docked ? { flex: "1 1 auto", width: "auto", maxWidth: "none" } : { width }}
      aria-label="AI workbench"
      hidden={!open}
    >
      {docked ? null : <div className="agent-workbench-resizer" onMouseDown={startResize} />}
      <div
        className="agent-workbench-body"
        style={{ gridTemplateColumns: `${sessionWidth}px minmax(0, 1fr)` }}
      >
        <section className="agent-session-column">
          <div className="agent-session-actions">
            <span>Sessions</span>
            <div>
              {closedSessions.length > 0 ? (
                <button
                  type="button"
                  className={showClosed ? "active" : ""}
                  onClick={() => setShowClosed((current) => !current)}
                >{showClosed ? "Open" : `Closed ${closedSessions.length}`}</button>
                ) : null}
              <button type="button" onClick={showNewSession}>New</button>
              <button
                type="button"
                className="agent-workbench-close"
                onClick={onClose}
                title="Close AI workbench"
                aria-label="Close AI workbench"
              >
                <svg viewBox="0 0 14 14" aria-hidden="true">
                  <path d="m3 3 8 8M11 3l-8 8" />
                </svg>
              </button>
            </div>
          </div>
          {newSessionOpen ? (
            <div className="agent-new-session">
              <label>
                <span>Host</span>
                <select value={newSessionContext} onChange={(event) => setNewSessionContext(event.target.value)}>
                  {targets.map((target) => <option key={target.key} value={target.key}>{target.label}</option>)}
                </select>
              </label>
              <label>
                <span>Provider</span>
                <select value={newSessionProvider} onChange={(event) => setNewSessionProvider(event.target.value as AiKind)}>
                  {AI_KINDS.map((kind) => {
                    const snapshot = targetSnapshots[newSessionContext];
                    return (
                      <option
                        key={kind}
                        value={kind}
                        disabled={snapshot?.probed === true && !snapshot.installed.has(kind)}
                      >{PROVIDER_NAMES[kind]}</option>
                    );
                  })}
                </select>
              </label>
              <button type="button" onClick={createUnifiedSession}>Start</button>
            </div>
          ) : null}
          <input
            type="search"
            value={sessionSearch}
            onChange={(event) => setSessionSearch(event.target.value)}
            placeholder="Search host, provider, or session"
            aria-label="Search sessions"
          />
          <div className="agent-session-list">
            {filteredSessions.map((entry) => {
              const goal = targetSnapshots[entry.contextKey]
                ?.goals[sessionGoalKey(entry.provider, entry.session.id)];
              // Running on the host (another device or terminal) without a
              // local stream; show activity but no Stop control to offer.
              const remoteActive = !entry.runtime.running && isSessionActive(entry.session, Date.now());
              return (
              <div
                key={desktopSessionKey(entry)}
                className={desktopSessionKey(entry) === activeSessionKey
                  ? "agent-session-row active"
                  : "agent-session-row"}
              >
                <button
                  type="button"
                  className="agent-session-main"
                  onClick={() => selectUnifiedSession(entry)}
                >
                  <span className="agent-session-context">
                    <ProviderMark provider={entry.provider} />
                    <span>{entry.contextLabel}</span>
                  </span>
                  <strong>{entry.session.title}</strong>
                  {goal ? (
                    <span className={`agent-session-goal ${goal.status}`}>{goal.text}</span>
                  ) : null}
                  <span className="agent-session-cwd">{entry.session.cwd ?? entry.session.id}</span>
                  <small className={entry.runtime.running || remoteActive ? "running" : ""}>
                    {entry.runtime.running
                      ? sessionRuntimeLabel(entry.runtime)
                      : remoteActive
                        ? "Active"
                        : relativeTime(entry.session.updatedAt)}
                  </small>
                </button>
                {entry.runtime.running ? (
                  <button type="button" className="agent-session-control stop" onClick={() => requestCommand(entry, "stop")}>Stop</button>
                ) : entry.closed ? (
                  <button type="button" className="agent-session-control" onClick={() => requestCommand(entry, "restore")}>Restore</button>
                ) : (
                  <button
                    type="button"
                    className="agent-session-control close"
                    onClick={() => requestCommand(entry, "close")}
                    title={`Close session ${entry.session.title}`}
                    aria-label={`Close session ${entry.session.title}`}
                  >
                    <svg viewBox="0 0 14 14" aria-hidden="true">
                      <path d="m3 3 8 8M11 3l-8 8" />
                    </svg>
                  </button>
                )}
              </div>
              );
            })}
            {filteredSessions.length === 0 ? <p>No saved sessions</p> : null}
          </div>
          <div className="agent-session-resizer" onMouseDown={startSessionResize} />
        </section>

        <div className="agent-main-column">
          <div className="agent-target-runtimes">
            {targets.map((target) => (
              <DesktopTargetRuntime
                key={target.key}
                command={command}
                discover={open}
                active={open && target.key === activeTargetKey}
                selection={selection}
                target={target}
                onSnapshot={updateTargetSnapshot}
              />
            ))}
          </div>
          {docked ? (
            <div className="agent-terminal-dock" style={{ height: dockHeight }}>
              <div className="agent-terminal-dock-resizer" onMouseDown={startDockResize} />
              <div className="agent-terminal-dock-body">{dock}</div>
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
};
