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
  JsonLineDecoder,
  normalizeClaudeHistoryMessage,
  normalizeClaudeMessage,
  type AgentPermissionOption,
  type MobileAgentEvent,
  type MobileSession,
  type MobileTimelineItem,
} from "../mobile/agentProtocol.ts";
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

interface ApprovalRequest {
  requestId: string | number;
  title: string;
  detail: string;
  options?: AgentPermissionOption[];
}

interface ProviderView {
  sessions: MobileSession[];
  activeSessionId: string | null;
  items: MobileTimelineItem[];
  approvals: ApprovalRequest[];
  activeTurnId: string | null;
  running: boolean;
  queue: string[];
  error: string | null;
  status: "idle" | "connecting" | "ready";
}

interface ChannelMeta {
  provider: AiKind;
  purpose: "provider" | "claude-list" | "claude-history";
  handledPayload: boolean;
}

const MIN_WORKBENCH_WIDTH = 420;
const MIN_TERMINAL_WIDTH = 280;

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
  items: [],
  approvals: [],
  activeTurnId: null,
  running: false,
  queue: [],
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

const withoutLoadingItem = (items: MobileTimelineItem[]): MobileTimelineItem[] =>
  items.filter((item) => !item.id.startsWith("loading-"));

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
  const [draft, setDraft] = useState("");
  const [queueMode, setQueueMode] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const [width, setWidth] = useState(560);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const viewsRef = useRef(views);
  const channels = useRef(new Map<string, ChannelMeta>());
  const providerChannels = useRef(new Map<AiKind, string>());
  const openingProviders = useRef(new Map<AiKind, Promise<void>>());
  const decoders = useRef(new Map<string, JsonLineDecoder>());
  const codexClients = useRef(new Map<AiKind, CodexMobileClient>());
  const acpClients = useRef(new Map<AiKind, AcpClient>());
  const expectedClose = useRef(new Set<string>());
  const stderr = useRef(new Map<string, string>());
  const channelSequence = useRef(0);
  const runtimeGeneration = useRef(0);
  const submitRef = useRef<(provider: AiKind, text: string, queued?: boolean) => Promise<void>>(async () => {});

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
  const latestTimelineTextLength = view.items[view.items.length - 1]?.text.length ?? 0;

  const updateView = useCallback((kind: AiKind, update: (current: ProviderView) => ProviderView) => {
    setViews((current) => {
      const next = { ...current, [kind]: update(current[kind]) };
      viewsRef.current = next;
      return next;
    });
  }, []);

  const nextChannelId = useCallback((kind: AiKind, purpose: ChannelMeta["purpose"]): string => {
    channelSequence.current += 1;
    return `${kind}-${purpose}-${Date.now()}-${channelSequence.current}`;
  }, []);

  const closeChannel = useCallback(async (channelId: string): Promise<void> => {
    expectedClose.current.add(channelId);
    await closeDesktopAgent(channelId).catch(() => {});
    channels.current.delete(channelId);
    decoders.current.delete(channelId);
  }, []);

  const applyEvent = useCallback((kind: AiKind, event: MobileAgentEvent): void => {
    switch (event.type) {
      case "sessionsLoaded":
        updateView(kind, (current) => ({ ...current, sessions: event.sessions, status: "ready" }));
        return;
      case "sessionLoaded":
        updateView(kind, (current) => ({
          ...current,
          activeSessionId: event.session.id,
          items: event.items,
          sessions: [event.session, ...current.sessions.filter((session) => session.id !== event.session.id)],
          status: "ready",
        }));
        requestAnimationFrame(() => {
          if (timelineRef.current) timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
        });
        return;
      case "turnStarted":
        updateView(kind, (current) => ({
          ...current,
          activeSessionId: event.sessionId,
          activeTurnId: event.turnId,
          running: true,
        }));
        return;
      case "turnCompleted": {
        const queued = viewsRef.current[kind].queue;
        updateView(kind, (current) => ({
          ...current,
          activeTurnId: null,
          running: false,
          queue: queued.slice(1),
        }));
        if (queued[0]) setTimeout(() => void submitRef.current(kind, queued[0], true), 0);
        return;
      }
      case "messageDelta":
        updateView(kind, (current) => ({
          ...current,
          items: appendDelta(current.items, event.itemId, event.text),
        }));
        return;
      case "userMessage":
        updateView(kind, (current) => ({
          ...current,
          items: appendDelta(current.items, event.itemId, event.text, "user"),
        }));
        return;
      case "messageCompleted":
        updateView(kind, (current) => ({
          ...current,
          activeSessionId: event.sessionId || current.activeSessionId,
          items: appendItem(current.items, {
            id: event.itemId ?? `assistant-${Date.now()}-${current.items.length}`,
            kind: "assistant",
            text: event.text,
          }),
        }));
        return;
      case "toolStarted":
        updateView(kind, (current) => ({
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
        updateView(kind, (current) => ({
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
          items: withoutLoadingItem(current.items),
          status: "ready",
          error: event.message,
        }));
    }
  }, [updateView]);

  const openClaudeAux = useCallback(async (
    purpose: "claude-list" | "claude-history",
    sessionId?: string,
  ): Promise<void> => {
    const channelId = nextChannelId("claude", purpose);
    channels.current.set(channelId, { provider: "claude", purpose, handledPayload: false });
    decoders.current.set(channelId, new JsonLineDecoder());
    try {
      if (sessionId) await loadDesktopClaudeSession(channelId, sessionId, target);
      else await listDesktopClaudeSessions(channelId, target);
    } catch (reason) {
      channels.current.delete(channelId);
      updateView("claude", (current) => ({
        ...current,
        items: withoutLoadingItem(current.items),
        status: "ready",
        error: String(reason),
      }));
    }
  }, [nextChannelId, target, updateView]);

  const openProvider = useCallback((kind: AiKind, sessionId?: string): Promise<void> => {
    if (providerChannels.current.has(kind)) return Promise.resolve();
    const existing = openingProviders.current.get(kind);
    if (existing) return existing;
    const generation = runtimeGeneration.current;
    const opening = (async () => {
      const channelId = nextChannelId(kind, "provider");
      channels.current.set(channelId, { provider: kind, purpose: "provider", handledPayload: false });
      decoders.current.set(channelId, new JsonLineDecoder());
      updateView(kind, (current) => ({ ...current, status: "connecting", error: null }));
      try {
        await openDesktopAgent(channelId, kind, target, kind === "claude" ? sessionId : undefined);
        if (generation !== runtimeGeneration.current) {
          await closeChannel(channelId);
          return;
        }
        providerChannels.current.set(kind, channelId);
        if (kind === "codex") {
          const client = new CodexMobileClient(
            (line) => writeDesktopAgentLine(channelId, line),
            (event) => applyEvent(kind, event),
          );
          codexClients.current.set(kind, client);
          await client.initialize();
        } else if (kind === "claude") {
          updateView(kind, (current) => ({ ...current, status: "ready" }));
          await openClaudeAux(sessionId ? "claude-history" : "claude-list", sessionId);
        } else {
          const client = new AcpClient(
            kind,
            (line) => writeDesktopAgentLine(channelId, line),
            (event) => applyEvent(kind, event),
          );
          acpClients.current.set(kind, client);
          await client.initialize();
          updateView(kind, (current) => ({ ...current, status: "ready" }));
        }
      } catch (reason) {
        updateView(kind, (current) => ({ ...current, status: "idle", error: String(reason) }));
        providerChannels.current.delete(kind);
        codexClients.current.get(kind)?.close();
        acpClients.current.get(kind)?.close();
        codexClients.current.delete(kind);
        acpClients.current.delete(kind);
        await closeChannel(channelId);
      } finally {
        openingProviders.current.delete(kind);
      }
    })();
    openingProviders.current.set(kind, opening);
    return opening;
  }, [applyEvent, closeChannel, nextChannelId, openClaudeAux, target, updateView]);

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
          updateView(meta.provider, (current) => ({
            ...current,
            running: false,
            status: "idle",
            error: detail || `${PROVIDER_NAMES[meta.provider]} exited with status ${event.exitStatus}`,
          }));
        }
        return;
      }
      if (event.kind === "closed") {
        if (meta.purpose !== "provider" && !meta.handledPayload) {
          const detail = stderr.current.get(event.channelId);
          updateView("claude", (current) => ({
            ...current,
            items: meta.purpose === "claude-history"
              ? withoutLoadingItem(current.items)
              : current.items,
            status: "ready",
            error: detail || (meta.purpose === "claude-history"
              ? "Claude session history returned no data"
              : "Claude session list returned no data"),
          }));
        }
        channels.current.delete(event.channelId);
        decoders.current.delete(event.channelId);
        stderr.current.delete(event.channelId);
        if (providerChannels.current.get(meta.provider) === event.channelId) {
          providerChannels.current.delete(meta.provider);
          codexClients.current.get(meta.provider)?.close();
          acpClients.current.get(meta.provider)?.close();
          codexClients.current.delete(meta.provider);
          acpClients.current.delete(meta.provider);
        }
        return;
      }
      if (event.kind !== "stdout" || !event.data) return;
      const decoder = decoders.current.get(event.channelId) ?? new JsonLineDecoder();
      decoders.current.set(event.channelId, decoder);
      for (const line of decoder.push(event.data)) {
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
            applyEvent("claude", {
              type: "sessionsLoaded",
              sessions: message.sessions as MobileSession[],
            });
            continue;
          }
          const historyEvents = normalizeClaudeHistoryMessage(message);
          const normalized = historyEvents.length > 0
            ? historyEvents
            : normalizeClaudeMessage(message);
          if (normalized.length > 0) meta.handledPayload = true;
          for (const item of normalized) applyEvent("claude", item);
        } catch {
          meta.handledPayload = true;
          updateView(meta.provider, (current) => ({
            ...current,
            items: meta.purpose === "claude-history"
              ? withoutLoadingItem(current.items)
              : current.items,
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
  }, [applyEvent, updateView]);

  useEffect(() => {
    if (!open || !leaf) return;
    let cancelled = false;
    runtimeGeneration.current += 1;
    setProbing(true);
    setInstalled(new Set());
    setProbedTarget(null);
    setViews(emptyViews());
    viewsRef.current = emptyViews();
    const currentChannels = [...channels.current.keys()];
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
        if (!found.has(provider)) setProvider(AI_KINDS.find((kind) => found.has(kind)) ?? "codex");
      })
      .catch((reason) => {
        if (!cancelled) updateView(provider, (current) => ({ ...current, error: String(reason) }));
      })
      .finally(() => {
        if (!cancelled) setProbing(false);
      });
    return () => { cancelled = true; };
  }, [closeChannel, leaf?.id, open, targetKey]);

  useEffect(() => {
    if (open && probedTarget === targetKey && installed.has(provider)) void openProvider(provider);
  }, [installed, open, openProvider, probedTarget, provider, targetKey]);

  useLayoutEffect(() => {
    if (!open || !timelineRef.current) return;
    timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
  }, [
    latestTimelineTextLength,
    open,
    provider,
    view.approvals.length,
    view.items.length,
    view.running,
  ]);

  const selectSession = async (session: MobileSession): Promise<void> => {
    updateView(provider, (current) => ({
      ...current,
      activeSessionId: session.id,
      items: [{ id: `loading-${session.id}`, kind: "status", text: "Loading session…" }],
      approvals: [],
      error: null,
    }));
    try {
      if (provider === "codex") {
        await codexClients.current.get(provider)?.resumeSession(session.id);
      } else if (provider === "claude") {
        const previous = providerChannels.current.get(provider);
        if (previous) {
          providerChannels.current.delete(provider);
          await closeChannel(previous);
        }
        await openProvider(provider, session.id);
      } else {
        await acpClients.current.get(provider)?.loadSession(session.id, session.cwd ?? target.cwd ?? ".");
      }
    } catch (reason) {
      updateView(provider, (current) => ({
        ...current,
        items: withoutLoadingItem(current.items),
        error: String(reason),
      }));
    }
  };

  const newSession = async (): Promise<void> => {
    updateView(provider, (current) => ({ ...current, items: [], approvals: [], error: null }));
    try {
      let sessionId: string | undefined;
      if (provider === "codex") {
        sessionId = await codexClients.current.get(provider)?.startSession(target.cwd);
      } else if (provider === "claude") {
        const previous = providerChannels.current.get(provider);
        if (previous) {
          providerChannels.current.delete(provider);
          await closeChannel(previous);
        }
        await openProvider(provider);
      } else {
        sessionId = await acpClients.current.get(provider)?.newSession(target.cwd ?? ".");
      }
      updateView(provider, (current) => ({ ...current, activeSessionId: sessionId ?? null }));
    } catch (reason) {
      updateView(provider, (current) => ({ ...current, error: String(reason) }));
    }
  };

  const sendText = async (kind: AiKind, text: string, queued = false): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const current = viewsRef.current[kind];
    if (current.running && queueMode && !queued) {
      updateView(kind, (state) => ({ ...state, queue: [...state.queue, trimmed] }));
      setDraft("");
      return;
    }
    setDraft("");
    updateView(kind, (state) => ({
      ...state,
      error: null,
      running: true,
      items: [...state.items, { id: `user-${Date.now()}`, kind: "user", text: trimmed }],
    }));
    try {
      await openProvider(kind, kind === "claude" ? current.activeSessionId ?? undefined : undefined);
      let sessionId = viewsRef.current[kind].activeSessionId;
      if (kind === "codex") {
        const client = codexClients.current.get(kind);
        if (!client) throw new Error("Codex channel is not ready");
        if (!sessionId) {
          sessionId = await client.startSession(target.cwd);
          updateView(kind, (state) => ({ ...state, activeSessionId: sessionId ?? null }));
        }
        if (current.running && current.activeTurnId && !queued) {
          await client.steer(sessionId, current.activeTurnId, trimmed);
        } else {
          await client.startTurn(sessionId, trimmed, target.cwd);
        }
      } else if (kind === "claude") {
        const channelId = providerChannels.current.get(kind);
        if (!channelId) throw new Error("Claude channel is not ready");
        await writeDesktopAgentLine(channelId, claudeInput(trimmed));
      } else {
        const client = acpClients.current.get(kind);
        if (!client) throw new Error(`${PROVIDER_NAMES[kind]} channel is not ready`);
        if (!sessionId) {
          sessionId = await client.newSession(target.cwd ?? ".");
          updateView(kind, (state) => ({ ...state, activeSessionId: sessionId ?? null }));
        }
        if (current.running && !queued) await client.cancel(sessionId);
        const stopReason = await client.prompt(sessionId, trimmed);
        applyEvent(kind, { type: "turnCompleted", sessionId, status: stopReason });
      }
    } catch (reason) {
      updateView(kind, (state) => ({ ...state, running: false, error: String(reason) }));
    }
  };
  submitRef.current = sendText;

  const stop = async (): Promise<void> => {
    const current = viewsRef.current[provider];
    const sessionId = current.activeSessionId;
    try {
      if (provider === "codex" && sessionId && current.activeTurnId) {
        await codexClients.current.get(provider)?.interrupt(sessionId, current.activeTurnId);
      } else if (provider === "claude") {
        const channelId = providerChannels.current.get(provider);
        if (channelId) {
          providerChannels.current.delete(provider);
          await closeChannel(channelId);
        }
      } else if (sessionId) {
        await acpClients.current.get(provider)?.cancel(sessionId);
      }
      updateView(provider, (state) => ({ ...state, running: false, activeTurnId: null }));
    } catch (reason) {
      updateView(provider, (state) => ({ ...state, error: String(reason) }));
    }
  };

  const resolveApproval = async (
    approval: ApprovalRequest,
    optionId?: string,
    accepted = false,
  ): Promise<void> => {
    try {
      if (provider === "codex") {
        await codexClients.current.get(provider)?.resolveApproval(approval.requestId, accepted);
      } else if (provider !== "claude") {
        await acpClients.current.get(provider)?.resolvePermission(approval.requestId, optionId);
      }
      updateView(provider, (current) => ({
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
              {filteredSessions.map((session) => (
                <button
                  type="button"
                  key={session.id}
                  className={session.id === view.activeSessionId ? "active" : ""}
                  onClick={() => void selectSession(session)}
                >
                  <strong>{session.title}</strong>
                  <span>{session.cwd ?? session.id}</span>
                  <small>{relativeTime(session.updatedAt)}</small>
                </button>
              ))}
              {filteredSessions.length === 0 ? <p>No saved sessions</p> : null}
            </div>
          </section>

          <section className="agent-conversation">
            <header className="agent-conversation-header">
              <div>
                <span>{PROVIDER_NAMES[provider]}</span>
                <strong>{activeSession?.title ?? "New session"}</strong>
              </div>
              <span className={view.running ? "agent-run-state running" : "agent-run-state"}>
                {view.status === "connecting" ? "Connecting" : view.running ? "Running" : "Ready"}
              </span>
            </header>

            <div ref={timelineRef} className="agent-timeline" aria-live="polite">
              {view.error ? (
                <div className="agent-inline-error" role="alert">
                  <span>{view.error}</span>
                  <button type="button" onClick={() => updateView(provider, (current) => ({ ...current, error: null }))}>Dismiss</button>
                </div>
              ) : null}
              {view.items.length === 0 && view.approvals.length === 0 ? (
                <div className="agent-timeline-empty">
                  <strong>Send the next instruction</strong>
                  <p>Messages and tool activity appear here. The provider terminal stays hidden.</p>
                </div>
              ) : null}
              {view.items.map((item) => (
                <article key={item.id} className={`agent-timeline-row ${item.kind}`}>
                  <span className="agent-timeline-rail" />
                  <div>
                    <small>{item.kind === "user" ? "You" : item.kind === "assistant" ? PROVIDER_NAMES[provider] : item.title ?? "Status"}</small>
                    {item.kind === "tool" ? <pre>{item.text}</pre> : <p>{item.text}</p>}
                  </div>
                </article>
              ))}
              {view.approvals.map((approval) => (
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
              {view.running ? <div className="agent-working"><span /><span /><span /> Working</div> : null}
            </div>

            {view.queue.length > 0 ? (
              <div className="agent-queue-preview">
                <span>{view.queue.length} queued</span>
                <p>{view.queue[0]}</p>
                <button type="button" onClick={() => updateView(provider, (current) => ({ ...current, queue: [] }))}>Clear</button>
              </div>
            ) : null}

            <footer className={view.running && !queueMode ? "agent-composer steering" : "agent-composer"}>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    void sendText(provider, draft);
                  }
                }}
                placeholder={view.running && !queueMode ? "Redirect the active task…" : view.running ? "Add the next instruction…" : "Message the agent…"}
                rows={3}
              />
              <div className="agent-composer-actions">
                <div>
                  {view.running ? (
                    <>
                      <button type="button" className={!queueMode ? "active" : ""} onClick={() => setQueueMode(false)}>Steer</button>
                      <button type="button" className={queueMode ? "active" : ""} onClick={() => setQueueMode(true)}>Queue</button>
                    </>
                  ) : <span>Ctrl+Enter to send</span>}
                </div>
                <div>
                  {view.running ? <button type="button" className="agent-stop-button" onClick={() => void stop()}>Stop</button> : null}
                  <button type="button" className="agent-send-button" disabled={!draft.trim()} onClick={() => void sendText(provider, draft)}>
                    {view.running ? queueMode ? "Queue" : "Steer" : "Send"}
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
