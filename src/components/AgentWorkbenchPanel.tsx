import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AcpClient, automaticPermissionOptionId } from "../agent/acpClient.ts";
import {
  closeDesktopAgent,
  listDesktopClaudeSessions,
  loadDesktopClaudeSession,
  onDesktopAgentTransport,
  openDesktopAgent,
  probeDesktopAgents,
  writeDesktopAgentLine,
  type DesktopAgentTarget,
} from "../agent/desktopAgentBridge.ts";
import { useWorkspaceInfoStore } from "../hooks/useWorkspaceInfo.ts";
import {
  ClaudeStreamNormalizer,
  JsonLineDecoder,
  normalizeClaudeHistoryMessage,
  type MobileAgentEvent,
  type MobileSession,
  type MobileTimelineItem,
} from "../mobile/agentProtocol.ts";
import {
  beginSessionHistory,
  completeSessionHistory,
  createSessionRuntime,
  failSessionHistory,
  moveSessionRuntime,
  readSessionRuntime,
  sessionRuntimeLabel,
  sessionRuntimeKey,
  shouldProcessAgentChannelPayload,
  updateSessionRuntime,
  type AgentApprovalRequest,
  type AgentChannelPurpose,
  type AgentSessionRuntime,
  type AgentSessionRuntimes,
} from "../mobile/agentSessionRuntime.ts";
import {
  loadAgentWorkbenchSnapshot,
  saveAgentWorkbenchSnapshot,
  type AgentWorkbenchViewSnapshot,
} from "../mobile/agentWorkbenchPersistence.ts";
import { CodexMobileClient } from "../mobile/codexMobileClient.ts";
import { AI_KINDS } from "../stores/aiCli.ts";
import { useWorkspaceStore, type AiKind } from "../stores/workspace.ts";
import { parseSshCommandLine } from "../utils/sshConnection.ts";
import { findTerminalLeaf } from "../utils/terminalSessionLayout.ts";
import "./AgentWorkbenchPanel.css";

interface AgentWorkbenchPanelProps {
  open: boolean;
  onClose: () => void;
}

interface ProviderView {
  sessions: MobileSession[];
  activeSessionId: string | null;
  runtimes: AgentSessionRuntimes;
  error: string | null;
  status: "idle" | "connecting" | "ready";
}

interface ChannelMeta {
  provider: AiKind;
  purpose: AgentChannelPurpose;
  handledPayload: boolean;
  sessionId?: string;
}

const MIN_WORKBENCH_WIDTH = 420;
const MIN_TERMINAL_WIDTH = 280;
const CLAUDE_HELPER_TIMEOUT_MS = 30_000;
const DESKTOP_WORKBENCH_STORAGE_PREFIX = "wmux-desktop-agent-workbench-v1:";
const WORKBENCH_PERSIST_DELAY_MS = 200;

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

const emptyView = (): ProviderView => ({
  sessions: [],
  activeSessionId: null,
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

const restoreViews = (
  snapshots: Partial<Record<AiKind, AgentWorkbenchViewSnapshot>>,
): Record<AiKind, ProviderView> => {
  const views = emptyViews();
  for (const kind of AI_KINDS) {
    const snapshot = snapshots[kind];
    if (snapshot) views[kind] = { ...views[kind], ...snapshot };
  }
  return views;
};

const snapshotViews = (
  views: Record<AiKind, ProviderView>,
): Record<AiKind, AgentWorkbenchViewSnapshot> => Object.fromEntries(
  AI_KINDS.map((kind) => [kind, {
    sessions: views[kind].sessions,
    activeSessionId: views[kind].activeSessionId,
    runtimes: views[kind].runtimes,
  }]),
) as Record<AiKind, AgentWorkbenchViewSnapshot>;

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
  kind: "user" | "assistant" = "assistant",
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

const stoppedRuntimes = (runtimes: AgentSessionRuntimes): AgentSessionRuntimes =>
  Object.fromEntries(Object.entries(runtimes).map(([key, runtime]) => [key, {
    ...runtime,
    activeTurnId: null,
    connectionState: "disconnected",
    running: false,
    waiting: false,
  }]));

const claudeInput = (text: string): string => JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
});

const targetLabel = (target: DesktopAgentTarget): string => {
  const host = target.sshConnection?.target
    ?? parseSshCommandLine(target.sshCommand)?.connection.target
    ?? "local";
  return `${host} · ${target.cwd ?? "current directory"}`;
};

export const AgentWorkbenchPanel = ({ open, onClose }: AgentWorkbenchPanelProps) => {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeId = useWorkspaceStore((state) => state.activeId);
  const leafCwds = useWorkspaceInfoStore((state) => state.leafCwds);
  const workspaceInfo = useWorkspaceInfoStore((state) => state.info);
  const [provider, setProvider] = useState<AiKind>("codex");
  const [installed, setInstalled] = useState<Set<AiKind>>(new Set());
  const [probedTarget, setProbedTarget] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [views, setViews] = useState<Record<AiKind, ProviderView>>(emptyViews);
  const [sessionSearch, setSessionSearch] = useState("");
  const [width, setWidth] = useState(560);
  const timelineRef = useRef<HTMLDivElement | null>(null);
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
  const channelSequence = useRef(0);
  const runtimeGeneration = useRef(0);
  const submitRef = useRef<(
    provider: AiKind,
    sessionId: string | null,
    text: string,
    queued?: boolean,
  ) => Promise<void>>(async () => {});

  const workspace = workspaces.find((candidate) => candidate.id === activeId);
  const leaf = workspace
    ? findTerminalLeaf(workspaces, workspace.id, workspace.focusedLeafId)
    : undefined;
  const parsedSsh = parseSshCommandLine(leaf?.sshCommand ?? leaf?.command);
  const target = useMemo<DesktopAgentTarget>(() => ({
    cwd: workspace && leaf
      ? leafCwds[workspace.id]?.[leaf.id]
        ?? leaf.lastCwd
        ?? workspaceInfo[workspace.id]?.cwd
        ?? undefined
      : undefined,
    sshCommand: leaf?.sshCommand ?? (parsedSsh ? leaf?.command : undefined),
    sshConnection: leaf?.sshConnection ?? parsedSsh?.connection,
  }), [
    leaf?.command,
    leaf?.id,
    leaf?.lastCwd,
    leaf?.sshCommand,
    leaf?.sshConnection,
    leafCwds,
    parsedSsh,
    workspace,
    workspaceInfo,
  ]);
  const targetKey = `${target.sshConnection?.target ?? target.sshCommand ?? "local"}|${target.cwd ?? ""}`;
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
    return `${kind}-${purpose}-${Date.now()}-${channelSequence.current}`;
  }, []);

  const closeChannel = useCallback(async (channelId: string): Promise<void> => {
    const timeout = helperTimeouts.current.get(channelId);
    if (timeout) clearTimeout(timeout);
    helperTimeouts.current.delete(channelId);
    expectedClose.current.add(channelId);
    await closeDesktopAgent(channelId).catch(() => {});
    channels.current.delete(channelId);
    decoders.current.delete(channelId);
    claudeNormalizers.current.delete(channelId);
  }, []);

  const applyEvent = useCallback((kind: AiKind, event: MobileAgentEvent): void => {
    switch (event.type) {
      case "sessionsLoaded":
        updateView(kind, (current) => ({ ...current, sessions: event.sessions, status: "ready" }));
        return;
      case "sessionLoaded":
        updateView(kind, (current) => ({
          ...current,
          runtimes: updateSessionRuntime(
            current.runtimes,
            event.session.id,
            (runtime) => completeSessionHistory(runtime, event.items),
          ),
          sessions: [event.session, ...current.sessions.filter((session) => session.id !== event.session.id)],
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
        updateRuntime(kind, event.sessionId, (current) => ({
          ...current,
          activeTurnId: event.turnId,
          running: true,
          waiting: false,
        }));
        return;
      case "turnCompleted": {
        let queued: string | undefined;
        updateRuntime(kind, event.sessionId, (current) => {
          queued = current.queue[0];
          return {
            ...current,
            activeTurnId: null,
            running: false,
            waiting: false,
            queue: current.queue.slice(1),
          };
        });
        const next = queued;
        if (next) {
          setTimeout(() => void submitRef.current(kind, event.sessionId, next, true), 0);
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
          }),
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
      if (sessionId) await loadDesktopClaudeSession(channelId, sessionId, target);
      else await listDesktopClaudeSessions(channelId, target);
    } catch (reason) {
      channels.current.delete(channelId);
      decoders.current.delete(channelId);
      const timeout = helperTimeouts.current.get(channelId);
      if (timeout) clearTimeout(timeout);
      helperTimeouts.current.delete(channelId);
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
  }, [closeChannel, nextChannelId, target, updateView]);

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
      channels.current.set(channelId, {
        provider: kind,
        purpose: "provider",
        handledPayload: false,
        ...(sessionId ? { sessionId } : {}),
      });
      decoders.current.set(channelId, new JsonLineDecoder());
      if (kind === "claude") {
        claudeNormalizers.current.set(channelId, new ClaudeStreamNormalizer());
      }
      updateView(kind, (current) => ({ ...current, status: "connecting", error: null }));
      try {
        await openDesktopAgent(channelId, kind, target, kind === "claude" ? sessionId : undefined);
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
          await client.initialize();
          const activeSessionId = sessionId ?? viewsRef.current[kind].activeSessionId ?? undefined;
          if (activeSessionId) {
            try {
              await client.resumeSession(activeSessionId);
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
          const activeSessionId = sessionId ?? viewsRef.current[kind].activeSessionId ?? undefined;
          if (activeSessionId) {
            const activeSession = viewsRef.current[kind].sessions.find(
              (candidate) => candidate.id === activeSessionId,
            );
            try {
              await client.loadSession(activeSessionId, activeSession?.cwd ?? target.cwd ?? ".");
            } catch (reason) {
              updateView(kind, (current) => ({ ...current, error: String(reason) }));
            }
          }
          updateView(kind, (current) => ({ ...current, status: "ready" }));
        }
        updateRuntime(kind, sessionId ?? viewsRef.current[kind].activeSessionId, (runtime) => ({
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
        if (meta.purpose !== "provider" && !meta.handledPayload) {
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
          if (message.type === "wmux_sessions" && Array.isArray(message.sessions)) {
            meta.handledPayload = true;
            const timeout = helperTimeouts.current.get(event.channelId);
            if (timeout) clearTimeout(timeout);
            helperTimeouts.current.delete(event.channelId);
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
              updateView("claude", (current) => ({
                ...current,
                activeSessionId: current.activeSessionId === (previousId ?? null)
                  ? eventSessionId
                  : current.activeSessionId,
                runtimes: moveSessionRuntime(current.runtimes, previousId, eventSessionId),
              }));
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
  }, [applyEvent, updateRuntime, updateView]);

  useEffect(() => {
    if (!open || !leaf || probedTarget === targetKey) return;
    let cancelled = false;
    runtimeGeneration.current += 1;
    setProbing(true);
    setInstalled(new Set());
    setProbedTarget(null);
    const currentChannels = [...channels.current.keys()];
    channels.current.clear();
    decoders.current.clear();
    claudeNormalizers.current.clear();
    stderr.current.clear();
    for (const timeout of helperTimeouts.current.values()) clearTimeout(timeout);
    helperTimeouts.current.clear();
    const restored = loadAgentWorkbenchSnapshot(
      `${DESKTOP_WORKBENCH_STORAGE_PREFIX}${targetKey}`,
      AI_KINDS,
    );
    const nextViews = restoreViews(restored?.views ?? {});
    const restoredProvider = restored?.provider ?? provider;
    setViews(nextViews);
    viewsRef.current = nextViews;
    setProvider(restoredProvider);
    providerChannels.current.clear();
    openingProviders.current.clear();
    for (const client of codexClients.current.values()) client.close("Target changed");
    for (const client of acpClients.current.values()) client.close("Target changed");
    codexClients.current.clear();
    acpClients.current.clear();
    for (const channelId of currentChannels) void closeChannel(channelId);
    void probeDesktopAgents(AI_KINDS, target)
      .then((found) => {
        if (cancelled) return;
        setInstalled(found);
        setProbedTarget(targetKey);
        if (!found.has(restoredProvider)) {
          setProvider(AI_KINDS.find((kind) => found.has(kind)) ?? "codex");
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          updateView(restoredProvider, (current) => ({ ...current, error: String(reason) }));
        }
      })
      .finally(() => {
        if (!cancelled) setProbing(false);
      });
    return () => { cancelled = true; };
  }, [closeChannel, leaf?.id, open, probedTarget, targetKey]);

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
      if (document.visibilityState === "hidden") persistWorkbench();
    };
    document.addEventListener("visibilitychange", persistWhenHidden);
    return () => document.removeEventListener("visibilitychange", persistWhenHidden);
  }, [persistWorkbench]);

  useEffect(() => {
    if (!open || probedTarget !== targetKey || !installed.has(provider)) return;
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
  }, [installed, open, openClaudeAux, openProvider, probedTarget, provider, targetKey]);

  useLayoutEffect(() => {
    if (!open || !timelineRef.current) return;
    timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
  }, [
    latestTimelineTextLength,
    open,
    provider,
    runtime.approvals.length,
    runtime.items.length,
    runtime.running,
  ]);

  const selectSession = async (session: MobileSession): Promise<void> => {
    const selectedRuntime = readSessionRuntime(viewsRef.current[provider].runtimes, session.id);
    const shouldReconnect = selectedRuntime.connectionState === "disconnected";
    const shouldLoadHistory = selectedRuntime.historyState === "idle";
    updateView(provider, (current) => ({
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
      const providerClientMissing = provider === "codex"
        ? !codexClients.current.has(provider)
        : provider !== "claude" && !acpClients.current.has(provider);
      if (shouldReconnect || providerClientMissing) {
        await openProvider(provider, provider === "claude" ? session.id : undefined);
        return;
      }
      if (provider === "codex") {
        if (shouldLoadHistory) await codexClients.current.get(provider)?.resumeSession(session.id);
      } else if (provider === "claude") {
        if (shouldLoadHistory) await openClaudeAux("claude-history", session.id);
      } else {
        if (shouldLoadHistory) {
          await acpClients.current.get(provider)?.loadSession(session.id, session.cwd ?? target.cwd ?? ".");
        }
      }
    } catch (reason) {
      updateView(provider, (current) => ({
        ...current,
        runtimes: updateSessionRuntime(current.runtimes, session.id, failSessionHistory),
        error: String(reason),
      }));
    }
  };

  const newSession = async (): Promise<void> => {
    updateView(provider, (current) => ({
      ...current,
      activeSessionId: null,
      runtimes: { ...current.runtimes, [sessionRuntimeKey(null)]: createSessionRuntime() },
      error: null,
    }));
    try {
      let sessionId: string | undefined;
      if (provider === "codex") {
        sessionId = await codexClients.current.get(provider)?.startSession(target.cwd);
      } else if (provider === "claude") {
        await openProvider(provider);
      } else {
        sessionId = await acpClients.current.get(provider)?.newSession(target.cwd ?? ".");
      }
      if (sessionId) {
        updateView(provider, (current) => ({
          ...current,
          activeSessionId: sessionId,
          runtimes: moveSessionRuntime(current.runtimes, null, sessionId),
        }));
      }
    } catch (reason) {
      updateView(provider, (current) => ({ ...current, error: String(reason) }));
    }
  };

  const sendText = async (
    kind: AiKind,
    text: string,
    queued = false,
    requestedSessionId?: string | null,
  ): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const current = viewsRef.current[kind];
    let sessionId = requestedSessionId === undefined
      ? current.activeSessionId
      : requestedSessionId;
    const currentRuntime = readSessionRuntime(current.runtimes, sessionId);
    if (currentRuntime.historyState === "loading") return;
    if (currentRuntime.running && currentRuntime.queueMode && !queued) {
      updateRuntime(kind, sessionId, (runtime) => ({
        ...runtime,
        queue: [...runtime.queue, trimmed],
        draft: "",
      }));
      return;
    }
    updateView(kind, (state) => ({ ...state, error: null }));
    updateRuntime(kind, sessionId, (runtime) => ({
      ...runtime,
      draft: "",
      running: true,
      waiting: false,
      historyState: "loaded",
      items: [...runtime.items, { id: `user-${Date.now()}`, kind: "user", text: trimmed }],
    }));
    try {
      const channelId = await openProvider(kind, kind === "claude" ? sessionId ?? undefined : undefined);
      if (kind === "codex") {
        const client = codexClients.current.get(kind);
        if (!client) throw new Error("Codex channel is not ready");
        if (!sessionId) {
          const createdSessionId = await client.startSession(target.cwd);
          sessionId = createdSessionId;
          updateView(kind, (state) => ({
            ...state,
            activeSessionId: state.activeSessionId === null ? createdSessionId : state.activeSessionId,
            runtimes: moveSessionRuntime(state.runtimes, null, createdSessionId),
          }));
        }
        if (currentRuntime.running && currentRuntime.activeTurnId && !queued) {
          await client.steer(sessionId, currentRuntime.activeTurnId, trimmed);
        } else {
          await client.startTurn(sessionId, trimmed, target.cwd);
        }
      } else if (kind === "claude") {
        if (!channelId) throw new Error("Claude channel is not ready");
        await writeDesktopAgentLine(channelId, claudeInput(trimmed));
      } else {
        const client = acpClients.current.get(kind);
        if (!client) throw new Error(`${PROVIDER_NAMES[kind]} channel is not ready`);
        if (!sessionId) {
          const createdSessionId = await client.newSession(target.cwd ?? ".");
          sessionId = createdSessionId;
          updateView(kind, (state) => ({
            ...state,
            activeSessionId: state.activeSessionId === null ? createdSessionId : state.activeSessionId,
            runtimes: moveSessionRuntime(state.runtimes, null, createdSessionId),
          }));
        }
        if (currentRuntime.running && !queued) await client.cancel(sessionId);
        const stopReason = await client.prompt(sessionId, trimmed);
        applyEvent(kind, { type: "turnCompleted", sessionId, status: stopReason });
      }
    } catch (reason) {
      updateRuntime(kind, sessionId, (runtime) => ({ ...runtime, running: false, waiting: false }));
      updateView(kind, (state) => ({ ...state, error: String(reason) }));
    }
  };
  submitRef.current = (kind, sessionId, text, queued) =>
    sendText(kind, text, queued, sessionId);

  const stop = async (): Promise<void> => {
    const current = viewsRef.current[provider];
    const sessionId = current.activeSessionId;
    const currentRuntime = readSessionRuntime(current.runtimes, sessionId);
    try {
      if (provider === "codex" && sessionId && currentRuntime.activeTurnId) {
        await codexClients.current.get(provider)?.interrupt(sessionId, currentRuntime.activeTurnId);
      } else if (provider === "claude") {
        const key = providerChannelKey(provider, sessionId);
        const channelId = providerChannels.current.get(key);
        if (channelId) {
          providerChannels.current.delete(key);
          await closeChannel(channelId);
        }
      } else if (sessionId) {
        await acpClients.current.get(provider)?.cancel(sessionId);
      }
      updateRuntime(provider, sessionId, (runtime) => ({
        ...runtime,
        running: false,
        waiting: false,
        activeTurnId: null,
        connectionState: provider === "claude" ? "idle" : runtime.connectionState,
      }));
    } catch (reason) {
      updateView(provider, (state) => ({ ...state, error: String(reason) }));
    }
  };

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

  const filteredSessions = view.sessions.filter((session) => {
    const search = sessionSearch.trim().toLowerCase();
    return !search || `${session.title} ${session.cwd ?? ""}`.toLowerCase().includes(search);
  });
  const activeSession = view.sessions.find((session) => session.id === view.activeSessionId);

  if (!open) return null;

  return (
    <aside className="agent-workbench" style={{ width }} aria-label="AI workbench">
      <div className="agent-workbench-resizer" onMouseDown={startResize} />
      <header className="agent-workbench-header">
        <div>
          <strong>AI workbench</strong>
          <span title={targetLabel(target)}>{targetLabel(target)}</span>
        </div>
        <button type="button" className="agent-icon-button" onClick={onClose} aria-label="Close AI workbench">×</button>
      </header>

      <nav className="agent-provider-tabs" aria-label="AI provider">
        {AI_KINDS.map((kind) => {
          const available = installed.has(kind);
          return (
            <button
              type="button"
              key={kind}
              className={provider === kind ? "active" : ""}
              disabled={!available}
              onClick={() => setProvider(kind)}
              title={available ? PROVIDER_NAMES[kind] : `${PROVIDER_NAMES[kind]} is not installed`}
            >
              <span>{PROVIDER_MARKS[kind]}</span>
              {PROVIDER_NAMES[kind]}
            </button>
          );
        })}
      </nav>

      {!leaf ? (
        <div className="agent-workbench-empty">
          <strong>Select a terminal pane</strong>
          <p>The workbench follows its host and working directory.</p>
        </div>
      ) : probing ? (
        <div className="agent-workbench-empty"><strong>Checking installed CLIs…</strong></div>
      ) : installed.size === 0 ? (
        <div className="agent-workbench-empty">
          <strong>No supported CLI found</strong>
          <p>Install a provider CLI on {target.sshConnection || target.sshCommand ? "the SSH host" : "this computer"}.</p>
        </div>
      ) : (
        <div className="agent-workbench-body">
          <section className="agent-session-column">
            <div className="agent-session-actions">
              <span>Sessions</span>
              <button type="button" onClick={() => void newSession()}>New</button>
            </div>
            <input
              type="search"
              value={sessionSearch}
              onChange={(event) => setSessionSearch(event.target.value)}
              placeholder="Search"
              aria-label="Search sessions"
            />
            <div className="agent-session-list">
              {filteredSessions.map((session) => {
                const sessionRuntime = readSessionRuntime(view.runtimes, session.id);
                return (
                  <button
                    type="button"
                    key={session.id}
                    className={session.id === view.activeSessionId ? "active" : ""}
                    onClick={() => void selectSession(session)}
                  >
                    <strong>{session.title}</strong>
                    <span>{session.cwd ?? session.id}</span>
                    <small className={sessionRuntime.running ? "running" : ""}>
                      {sessionRuntime.running ? sessionRuntimeLabel(sessionRuntime) : relativeTime(session.updatedAt)}
                    </small>
                  </button>
                );
              })}
              {filteredSessions.length === 0 ? <p>No saved sessions</p> : null}
            </div>
          </section>

          <section className="agent-conversation">
            <header className="agent-conversation-header">
              <div>
                <span>{PROVIDER_NAMES[provider]}</span>
                <strong>{activeSession?.title ?? "New session"}</strong>
              </div>
              <span className={runtime.running ? "agent-run-state running" : "agent-run-state"}>
                {view.status === "connecting" ? "Connecting" : sessionRuntimeLabel(runtime)}
              </span>
            </header>

            <div ref={timelineRef} className="agent-timeline" aria-live="polite">
              {view.error ? (
                <div className="agent-inline-error" role="alert">
                  <span>{view.error}</span>
                  <button type="button" onClick={() => updateView(provider, (current) => ({ ...current, error: null }))}>Dismiss</button>
                </div>
              ) : null}
              {runtime.items.length === 0 && runtime.approvals.length === 0 ? (
                <div className="agent-timeline-empty">
                  <strong>Send the next instruction</strong>
                  <p>Messages and tool activity appear here. The provider terminal stays hidden.</p>
                </div>
              ) : null}
              {runtime.items.map((item) => (
                <article key={item.id} className={`agent-timeline-row ${item.kind}`}>
                  <span className="agent-timeline-rail" />
                  <div>
                    <small>{item.kind === "user" ? "You" : item.kind === "assistant" ? PROVIDER_NAMES[provider] : item.title ?? "Status"}</small>
                    {item.kind === "tool" ? <pre>{item.text}</pre> : <p>{item.text}</p>}
                  </div>
                </article>
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
              {runtime.running ? <div className="agent-working"><span /><span /><span /> Working</div> : null}
            </div>

            {runtime.queue.length > 0 ? (
              <div className="agent-queue-preview">
                <span>{runtime.queue.length} queued</span>
                <p>{runtime.queue[0]}</p>
                <button type="button" onClick={() => updateRuntime(provider, view.activeSessionId, (current) => ({ ...current, queue: [] }))}>Clear</button>
              </div>
            ) : null}

            <footer className={runtime.running && !runtime.queueMode ? "agent-composer steering" : "agent-composer"}>
              <textarea
                value={runtime.draft}
                onChange={(event) => updateRuntime(provider, view.activeSessionId, (current) => ({
                  ...current,
                  draft: event.target.value,
                }))}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    void sendText(provider, runtime.draft);
                  }
                }}
                placeholder={runtime.running && !runtime.queueMode ? "Redirect the active task…" : runtime.running ? "Add the next instruction…" : "Message the agent…"}
                rows={3}
              />
              <div className="agent-composer-actions">
                <div>
                  {runtime.running ? (
                    <>
                      <button type="button" className={!runtime.queueMode ? "active" : ""} onClick={() => updateRuntime(provider, view.activeSessionId, (current) => ({ ...current, queueMode: false }))}>Steer</button>
                      <button type="button" className={runtime.queueMode ? "active" : ""} onClick={() => updateRuntime(provider, view.activeSessionId, (current) => ({ ...current, queueMode: true }))}>Queue</button>
                    </>
                  ) : <span>Ctrl+Enter to send</span>}
                </div>
                <div>
                  {runtime.running ? <button type="button" className="agent-stop-button" onClick={() => void stop()}>Stop</button> : null}
                  <button
                    type="button"
                    className="agent-send-button"
                    disabled={
                      !runtime.draft.trim()
                      || runtime.historyState === "loading"
                      || (provider === "codex" && runtime.running && !runtime.activeTurnId && !runtime.queueMode)
                    }
                    onClick={() => void sendText(provider, runtime.draft)}
                  >
                    {runtime.running ? runtime.queueMode ? "Queue" : "Steer" : "Send"}
                  </button>
                </div>
              </div>
            </footer>
          </section>
        </div>
      )}
    </aside>
  );
};
