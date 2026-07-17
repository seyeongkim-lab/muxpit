import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CodexMobileClient,
  type CodexModelOption,
} from "./codexMobileClient.ts";
import {
  ClaudeStreamNormalizer,
  JsonLineDecoder,
  composerAction,
  normalizeClaudeHistoryMessage,
  type MobileAgentEvent,
  type MobileSession,
  type MobileTimelineItem,
} from "./agentProtocol.ts";
import {
  beginSessionHistory,
  activeSessionCount,
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
  type AgentExecutionSettings,
  type AgentSessionRuntime,
  type AgentSessionRuntimes,
} from "./agentSessionRuntime.ts";
import {
  loadAgentWorkbenchSnapshot,
  saveAgentWorkbenchSnapshot,
  type AgentWorkbenchViewSnapshot,
} from "./agentWorkbenchPersistence.ts";
import {
  closeAgent,
  connectSsh,
  disconnectSsh,
  listClaudeSessions,
  loadClaudeSession,
  loadSshCredential,
  onAgentTransport,
  openAgent,
  probeAgent,
  probeSsh,
  saveSshCredential,
  writeAgentLine,
  type MobileAgentTransportEvent,
  type SshAuth,
} from "./mobileBridge.ts";
import {
  loadHostProfiles,
  saveHostProfiles,
  upsertHostProfile,
  type HostProfile,
} from "./hostProfiles.ts";
import "./mobile.css";

type Provider = "codex" | "claude";
type ConnectionStatus = "disconnected" | "connecting" | "connected";
const CLAUDE_HELPER_TIMEOUT_MS = 30_000;
const MOBILE_WORKBENCH_STORAGE_KEY = "wmux-mobile-agent-workbench-v1";
const MOBILE_PROVIDERS = ["codex", "claude"] as const;
const WORKBENCH_PERSIST_DELAY_MS = 200;

const mobileWorkbenchViewStorageKey = (profileId: string, provider: Provider): string =>
  `${MOBILE_WORKBENCH_STORAGE_KEY}:${encodeURIComponent(profileId)}:${provider}`;

const loadCachedWorkbenchView = (
  profileId: string,
  provider: Provider,
): AgentWorkbenchViewSnapshot | undefined => loadAgentWorkbenchSnapshot(
  mobileWorkbenchViewStorageKey(profileId, provider),
  MOBILE_PROVIDERS,
)?.views[provider];

const emptyWorkbenchView = (): AgentWorkbenchViewSnapshot => ({
  sessions: [],
  activeSessionId: null,
  runtimes: {},
});

interface MobileChannelMeta {
  provider: Provider;
  purpose: "provider" | "claude-list" | "claude-history";
  handledPayload: boolean;
  sessionId?: string;
  launchSettings?: AgentExecutionSettings;
}

const MOBILE_DEMO = import.meta.env.DEV
  && new URLSearchParams(window.location.search).has("demo");

const DEMO_PROFILE: HostProfile = {
  id: "mobile-demo",
  name: "Dev host",
  host: "dev.example",
  port: 22,
  user: "developer",
  cwd: "/home/developer/project",
};

const DEMO_SESSIONS: MobileSession[] = [
  { id: "demo-1", title: "Android client", cwd: "/home/developer/project", updatedAt: Math.floor(Date.now() / 1000), provider: "codex" },
  { id: "demo-2", title: "Fix CI failure", cwd: "/home/developer/service", updatedAt: Math.floor(Date.now() / 1000) - 1800, provider: "codex" },
  { id: "demo-3", title: "Review auth flow", cwd: "/home/developer/web", updatedAt: Math.floor(Date.now() / 1000) - 7200, provider: "codex" },
];

const DEMO_ITEMS: MobileTimelineItem[] = [
  { id: "demo-user", kind: "user", text: "Android build 상태를 확인하고 실패한 테스트를 수정해." },
  { id: "demo-agent", kind: "assistant", text: "빌드 환경을 확인했습니다. Android target을 추가한 뒤 release APK를 다시 만들고 있습니다." },
  { id: "demo-tool", kind: "tool", title: "Command", text: "pnpm tauri android build --apk" },
];

const DEMO_MODELS: CodexModelOption[] = [{
  id: "gpt-demo",
  model: "gpt-demo",
  displayName: "GPT Demo",
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: ["low", "medium", "high"],
  defaultServiceTier: null,
  serviceTiers: [{ id: "fast", name: "Fast" }],
}];

const CLAUDE_MODELS = ["opus", "sonnet", "fable"] as const;
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

interface ConnectionForm {
  id: string;
  name: string;
  host: string;
  port: string;
  user: string;
  cwd: string;
  authMode: "password" | "privateKey";
  password: string;
  privateKey: string;
  passphrase: string;
}

interface PendingTrust {
  profile: HostProfile;
  auth: SshAuth;
  fingerprint: string;
}

const newId = (): string =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `host-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const blankForm = (): ConnectionForm => ({
  id: newId(),
  name: "",
  host: "",
  port: "22",
  user: "",
  cwd: "",
  authMode: "password",
  password: "",
  privateKey: "",
  passphrase: "",
});

const formFromProfile = (profile: HostProfile): ConnectionForm => ({
  id: profile.id,
  name: profile.name,
  host: profile.host,
  port: String(profile.port),
  user: profile.user,
  cwd: profile.cwd,
  authMode: "password",
  password: "",
  privateKey: "",
  passphrase: "",
});

const profileFromForm = (form: ConnectionForm): HostProfile => ({
  id: form.id,
  name: form.name.trim() || form.host.trim(),
  host: form.host.trim(),
  port: Number(form.port),
  user: form.user.trim(),
  cwd: form.cwd.trim(),
});

const authFromForm = (form: ConnectionForm): SshAuth | undefined => {
  if (form.authMode === "password") {
    return form.password ? { type: "password", password: form.password } : undefined;
  }
  return form.privateKey
    ? {
        type: "privateKey",
        privateKey: form.privateKey,
        ...(form.passphrase ? { passphrase: form.passphrase } : {}),
      }
    : undefined;
};

const claudeInput = (text: string): string => JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "text", text }],
  },
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

const providerChannelKey = (provider: Provider, sessionId?: string | null): string =>
  provider === "claude" ? `${provider}:${sessionRuntimeKey(sessionId)}` : provider;

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

export const MobileApp = () => {
  const initialProfiles = useRef(MOBILE_DEMO ? [DEMO_PROFILE] : loadHostProfiles()).current;
  const initialWorkbench = useRef(MOBILE_DEMO
    ? undefined
    : loadAgentWorkbenchSnapshot(MOBILE_WORKBENCH_STORAGE_KEY, MOBILE_PROVIDERS)).current;
  const initialProvider = initialWorkbench?.provider ?? "codex";
  const initialProfile = initialProfiles.find((profile) => profile.id === initialWorkbench?.profileId)
    ?? initialProfiles[0];
  const [initialViews] = useState<Partial<Record<Provider, AgentWorkbenchViewSnapshot>>>(() =>
    MOBILE_DEMO
      ? {}
      : Object.fromEntries(MOBILE_PROVIDERS.flatMap((kind) => {
          const view = initialWorkbench?.views[kind]
            ?? (initialProfile ? loadCachedWorkbenchView(initialProfile.id, kind) : undefined);
          return view ? [[kind, view]] : [];
        })));
  const initialView = initialViews[initialProvider];
  const [profiles, setProfiles] = useState(initialProfiles);
  const [form, setForm] = useState<ConnectionForm>(() =>
    initialProfile ? formFromProfile(initialProfile) : blankForm());
  const [currentProfile, setCurrentProfile] = useState<HostProfile | null>(MOBILE_DEMO ? DEMO_PROFILE : null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(MOBILE_DEMO ? "connected" : "disconnected");
  const [pendingTrust, setPendingTrust] = useState<PendingTrust | null>(null);
  const [provider, setProvider] = useState<Provider>(MOBILE_DEMO ? "codex" : initialProvider);
  const [sessions, setSessions] = useState<MobileSession[]>(MOBILE_DEMO ? DEMO_SESSIONS : initialView?.sessions ?? []);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(MOBILE_DEMO ? "demo-1" : initialView?.activeSessionId ?? null);
  const [runtimes, setRuntimes] = useState<AgentSessionRuntimes>(() => MOBILE_DEMO ? {
    [sessionRuntimeKey("demo-1")]: {
      ...createSessionRuntime(),
      items: DEMO_ITEMS,
      activeTurnId: "demo-turn",
      running: true,
      executionSettings: { model: "gpt-demo", effort: "high", serviceTier: "fast" },
      approvals: [{ requestId: "demo-approval", title: "cargo test", detail: "Run the Rust test suite" }],
    },
  } : initialView?.runtimes ?? {});
  const [error, setError] = useState<string | null>(null);
  const [hostSheetOpen, setHostSheetOpen] = useState(false);
  const [sessionSheetOpen, setSessionSheetOpen] = useState(false);
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const [codexModels, setCodexModels] = useState<CodexModelOption[]>(MOBILE_DEMO ? DEMO_MODELS : []);
  const [, setProviderViewRevision] = useState(0);
  const runtime = readSessionRuntime(runtimes, activeSessionId);
  const { approvals, items, queue, running } = runtime;
  const latestTimelineTextLength = items[items.length - 1]?.text.length ?? 0;

  const credentialCache = useRef(new Map<string, SshAuth>());
  const restoredProfileId = useRef(initialWorkbench?.profileId);
  const decoders = useRef(new Map<string, JsonLineDecoder>());
  const claudeNormalizers = useRef(new Map<string, ClaudeStreamNormalizer>());
  const channels = useRef(new Map<string, MobileChannelMeta>());
  const providerChannels = useRef(new Map<string, string>());
  const openingProviders = useRef(new Map<string, Promise<string | undefined>>());
  const helperTimeouts = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const codexClient = useRef<CodexMobileClient | null>(null);
  const activeChannel = useRef<string | null>(null);
  const currentProfileRef = useRef<HostProfile | null>(null);
  const connectionStatusRef = useRef<ConnectionStatus>(connectionStatus);
  const providerRef = useRef<Provider>(provider);
  const sessionsRef = useRef<MobileSession[]>(sessions);
  const activeSessionRef = useRef<string | null>(activeSessionId);
  const runtimesRef = useRef<AgentSessionRuntimes>(runtimes);
  const providerViews = useRef<Partial<Record<Provider, AgentWorkbenchViewSnapshot>>>(initialViews);
  const timelineRef = useRef<HTMLElement | null>(null);
  const pendingSessionScrollRef = useRef<{ sessionId: string } | null>(null);
  const persistWorkbenchRef = useRef<() => void>(() => {});
  const normalizedHandlerRef = useRef<(provider: Provider, event: MobileAgentEvent) => void>(() => {});
  const transportHandlerRef = useRef<(event: MobileAgentTransportEvent) => void>(() => {});
  const resumeConnectionRef = useRef<() => Promise<void>>(async () => {});
  const resumeInFlightRef = useRef(false);
  const initialRestoreStarted = useRef(false);
  const runtimeGeneration = useRef(0);
  const channelSequence = useRef(0);
  const submitRef = useRef<(
    provider: Provider,
    sessionId: string | null,
    text: string,
    fromQueue?: boolean,
  ) => Promise<boolean>>(async () => false);
  const queuedDispatches = useRef(new Set<string>());

  useEffect(() => { connectionStatusRef.current = connectionStatus; }, [connectionStatus]);
  useEffect(() => { providerRef.current = provider; }, [provider]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { currentProfileRef.current = currentProfile; }, [currentProfile]);
  useEffect(() => { activeSessionRef.current = activeSessionId; }, [activeSessionId]);

  const credentialForProfile = async (profileId: string): Promise<SshAuth | undefined> => {
    const cached = credentialCache.current.get(profileId);
    if (cached) return cached;
    const stored = await loadSshCredential(profileId);
    if (!stored) return undefined;
    credentialCache.current.set(profileId, stored);
    return stored;
  };

  const activeProviderView = (): AgentWorkbenchViewSnapshot => ({
    sessions: sessionsRef.current,
    activeSessionId: activeSessionRef.current,
    runtimes: runtimesRef.current,
  });

  const readProviderView = (kind: Provider): AgentWorkbenchViewSnapshot =>
    kind === providerRef.current
      ? activeProviderView()
      : providerViews.current[kind] ?? emptyWorkbenchView();

  const replaceProviderView = (
    kind: Provider,
    view: AgentWorkbenchViewSnapshot,
  ): void => {
    providerViews.current = { ...providerViews.current, [kind]: view };
    if (kind !== providerRef.current) {
      setProviderViewRevision((revision) => revision + 1);
      return;
    }
    sessionsRef.current = view.sessions;
    activeSessionRef.current = view.activeSessionId;
    runtimesRef.current = view.runtimes;
    setSessions(view.sessions);
    setActiveSessionId(view.activeSessionId);
    setRuntimes(view.runtimes);
  };

  const updateProviderView = (
    kind: Provider,
    update: (current: AgentWorkbenchViewSnapshot) => AgentWorkbenchViewSnapshot,
  ): void => replaceProviderView(kind, update(readProviderView(kind)));

  const updateProviderRuntime = (
    kind: Provider,
    sessionId: string | null | undefined,
    update: (current: AgentSessionRuntime) => AgentSessionRuntime,
  ): void => updateProviderView(kind, (view) => ({
    ...view,
    runtimes: updateSessionRuntime(view.runtimes, sessionId, update),
  }));

  const moveProviderRuntime = (
    kind: Provider,
    fromSessionId: string | null,
    toSessionId: string,
  ): void => updateProviderView(kind, (view) => ({
    ...view,
    runtimes: moveSessionRuntime(view.runtimes, fromSessionId, toSessionId),
  }));

  const disconnectProviderRuntimes = (kind: Provider): void => {
    updateProviderView(kind, (view) => ({
      ...view,
      runtimes: Object.fromEntries(
        Object.entries(view.runtimes).map(([key, runtime]) => [key, {
          ...runtime,
          activeTurnId: null,
          connectionState: "disconnected",
          running: false,
          waiting: false,
        }]),
      ),
    }));
  };

  const setProviderError = (kind: Provider, message: string | null): void => {
    if (kind === providerRef.current) setError(message);
  };

  persistWorkbenchRef.current = (): void => {
    if (MOBILE_DEMO) return;
    const profileId = currentProfileRef.current?.id ?? restoredProfileId.current;
    if (!profileId) return;
    const currentProvider = providerRef.current;
    providerViews.current = {
      ...providerViews.current,
      [currentProvider]: activeProviderView(),
    };
    const snapshot = {
      provider: currentProvider,
      profileId,
      views: providerViews.current,
    };
    saveAgentWorkbenchSnapshot(MOBILE_WORKBENCH_STORAGE_KEY, snapshot);
    for (const kind of MOBILE_PROVIDERS) {
      const view = providerViews.current[kind];
      if (!view) continue;
      saveAgentWorkbenchSnapshot(mobileWorkbenchViewStorageKey(profileId, kind), {
        ...snapshot,
        views: { [kind]: view },
      });
    }
  };

  useEffect(() => {
    const timeout = setTimeout(() => persistWorkbenchRef.current(), WORKBENCH_PERSIST_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [activeSessionId, currentProfile?.id, provider, runtimes, sessions]);

  const updateRuntime = (
    sessionId: string | null | undefined,
    update: (current: AgentSessionRuntime) => AgentSessionRuntime,
  ): void => updateProviderRuntime(providerRef.current, sessionId, update);

  useLayoutEffect(() => {
    const pending = pendingSessionScrollRef.current;
    const timeline = timelineRef.current;
    if (!pending || pending.sessionId !== activeSessionId || !timeline) return;
    timeline.scrollTop = timeline.scrollHeight;
    pendingSessionScrollRef.current = null;
  }, [activeSessionId, items]);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }, [activeSessionId, approvals.length, items.length, latestTimelineTextLength, running]);

  useEffect(() => {
    if (MOBILE_DEMO) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onAgentTransport((event) => transportHandlerRef.current(event)).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (MOBILE_DEMO) return;
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") void resumeConnectionRef.current();
      else persistWorkbenchRef.current();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  const rememberProfile = (profile: HostProfile): void => {
    setProfiles((previous) => {
      const next = upsertHostProfile(previous, profile);
      saveHostProfiles(next);
      return next;
    });
  };

  const resetAgentState = (preserveView = false): void => {
    runtimeGeneration.current += 1;
    if (preserveView) {
      providerViews.current = {
        ...providerViews.current,
        [providerRef.current]: activeProviderView(),
      };
      for (const meta of channels.current.values()) {
        if (meta.purpose !== "provider") continue;
        if (meta.provider === "codex") {
          disconnectProviderRuntimes("codex");
        } else {
          updateProviderRuntime(meta.provider, meta.sessionId, (runtime) => ({
            ...runtime,
            activeTurnId: null,
            connectionState: "disconnected",
            running: false,
            waiting: false,
          }));
        }
      }
    }
    codexClient.current?.close("Connection reset");
    codexClient.current = null;
    activeChannel.current = null;
    channels.current.clear();
    providerChannels.current.clear();
    openingProviders.current.clear();
    for (const timeout of helperTimeouts.current.values()) clearTimeout(timeout);
    helperTimeouts.current.clear();
    decoders.current.clear();
    claudeNormalizers.current.clear();
    if (!preserveView) {
      setSessions([]);
      sessionsRef.current = [];
      setActiveSessionId(null);
      activeSessionRef.current = null;
      pendingSessionScrollRef.current = null;
    }
    const next = preserveView
      ? Object.fromEntries(Object.entries(runtimesRef.current).map(([key, runtime]) => [key, {
          ...runtime,
          activeTurnId: null,
          running: false,
          waiting: false,
        }]))
      : {};
    runtimesRef.current = next;
    setRuntimes(next);
    providerViews.current = preserveView
      ? {
          ...providerViews.current,
          [providerRef.current]: {
            sessions: sessionsRef.current,
            activeSessionId: activeSessionRef.current,
            runtimes: next,
          },
        }
      : {};
  };

  const replaceWorkbenchView = (view?: AgentWorkbenchViewSnapshot): void => {
    replaceProviderView(providerRef.current, view ?? emptyWorkbenchView());
  };

  const requestClaudeData = async (sessionId?: string): Promise<void> => {
    const purpose = sessionId ? "claude-history" : "claude-list";
    channelSequence.current += 1;
    const channelId = `${purpose}-${Date.now()}-${channelSequence.current}`;
    decoders.current.set(channelId, new JsonLineDecoder());
    channels.current.set(channelId, {
      provider: "claude",
      purpose,
      handledPayload: false,
      ...(sessionId ? { sessionId } : {}),
    });
    helperTimeouts.current.set(channelId, setTimeout(() => {
      const meta = channels.current.get(channelId);
      if (!meta || meta.handledPayload) return;
      meta.handledPayload = true;
      if (sessionId) updateProviderRuntime("claude", sessionId, failSessionHistory);
      setProviderError(
        "claude",
        sessionId ? "Claude session history timed out." : "Claude session list timed out.",
      );
      void closeAgent(channelId).catch(() => {});
    }, CLAUDE_HELPER_TIMEOUT_MS));
    try {
      if (sessionId) await loadClaudeSession(channelId, sessionId);
      else await listClaudeSessions(channelId);
    } catch (reason) {
      channels.current.delete(channelId);
      decoders.current.delete(channelId);
      const timeout = helperTimeouts.current.get(channelId);
      if (timeout) clearTimeout(timeout);
      helperTimeouts.current.delete(channelId);
      if (sessionId) {
        updateProviderRuntime("claude", sessionId, (runtime) => ({
          ...failSessionHistory(runtime),
        }));
      }
      setProviderError("claude", String(reason));
    }
  };

  const prepareProvider = async (nextProvider: Provider): Promise<void> => {
    if (nextProvider === providerRef.current) {
      setError(null);
      return;
    }
    persistWorkbenchRef.current();
    const profileId = currentProfileRef.current?.id ?? restoredProfileId.current;
    const nextView = providerViews.current[nextProvider]
      ?? (profileId ? loadCachedWorkbenchView(profileId, nextProvider) : undefined)
      ?? emptyWorkbenchView();
    setProvider(nextProvider);
    providerRef.current = nextProvider;
    replaceProviderView(nextProvider, nextView);
    activeChannel.current = providerChannels.current.get(
      providerChannelKey(nextProvider, nextView.activeSessionId),
    ) ?? null;
    setError(null);
  };

  const openProvider = async (
    profile: HostProfile,
    nextProvider: Provider,
    sessionId?: string,
    preserveView = false,
    cwd = profile.cwd,
    activate = true,
  ): Promise<string | undefined> => {
    if (activate) await prepareProvider(nextProvider);
    const providerView = readProviderView(nextProvider);
    const activeProviderSessionId = sessionId ?? providerView.activeSessionId ?? undefined;
    const sessionRuntime = readSessionRuntime(providerView.runtimes, activeProviderSessionId);
    const shouldRequestClaudeData = nextProvider === "claude"
      && (preserveView
        || (activeProviderSessionId
          ? sessionRuntime?.historyState !== "loaded"
          : sessionsRef.current.length === 0));
    if (activeProviderSessionId) {
      updateProviderView(nextProvider, (view) => ({
        ...view,
        activeSessionId: activeProviderSessionId,
      }));
      const shouldBeginHistory = sessionRuntime?.historyState !== "loading"
        && (
          (!preserveView && sessionRuntime?.historyState !== "loaded")
          || preserveView
        );
      if (shouldBeginHistory) {
        updateProviderRuntime(
          nextProvider,
          activeProviderSessionId,
          (runtime) => beginSessionHistory(runtime, activeProviderSessionId),
        );
      }
    }

    const key = providerChannelKey(nextProvider, activeProviderSessionId);
    const existingChannel = providerChannels.current.get(key);
    if (existingChannel) {
      if (nextProvider === providerRef.current) activeChannel.current = existingChannel;
      const needsCodexResume = nextProvider === "codex"
        && activeProviderSessionId
        && (
          preserveView
          || sessionRuntime.connectionState === "disconnected"
          || sessionRuntime.historyState !== "loaded"
        );
      if (needsCodexResume) {
        const settings = await codexClient.current?.resumeSession(activeProviderSessionId);
        if (settings) {
          updateProviderRuntime("codex", activeProviderSessionId, (runtime) => ({
            ...runtime,
            executionSettings: settings,
          }));
        }
      }
      updateProviderRuntime(nextProvider, activeProviderSessionId, (runtime) => ({
        ...runtime,
        connectionState: "connected",
      }));
      return existingChannel;
    }
    const existingOpening = openingProviders.current.get(key);
    if (existingOpening) return existingOpening;

    const generation = runtimeGeneration.current;
    channelSequence.current += 1;
    const channelId = `${nextProvider}-${Date.now()}-${channelSequence.current}`;
    if (nextProvider === providerRef.current) activeChannel.current = channelId;
    decoders.current.set(channelId, new JsonLineDecoder());
    channels.current.set(channelId, {
      provider: nextProvider,
      purpose: "provider",
      handledPayload: false,
      ...(activeProviderSessionId ? { sessionId: activeProviderSessionId } : {}),
      ...(nextProvider === "claude" ? { launchSettings: sessionRuntime.executionSettings } : {}),
    });
    if (nextProvider === "claude") {
      claudeNormalizers.current.set(channelId, new ClaudeStreamNormalizer());
    }
    let opening!: Promise<string | undefined>;
    opening = (async (): Promise<string | undefined> => {
      try {
        if (nextProvider === "claude") {
          await openAgent(
            channelId,
            nextProvider,
            activeProviderSessionId,
            cwd || undefined,
            sessionRuntime.executionSettings,
          );
          if (shouldRequestClaudeData) await requestClaudeData(activeProviderSessionId);
        } else {
          await openAgent(channelId, nextProvider, undefined, cwd || undefined);
          const client = new CodexMobileClient(
            (line) => writeAgentLine(channelId, line),
            (event) => normalizedHandlerRef.current("codex", event),
          );
          codexClient.current = client;
          await client.initialize();
          setCodexModels(await client.listModels().catch(() => []));
          if (activeProviderSessionId) {
            const settings = await client.resumeSession(activeProviderSessionId);
            updateProviderRuntime("codex", activeProviderSessionId, (runtime) => ({
              ...runtime,
              executionSettings: settings,
            }));
          }
        }
        if (generation !== runtimeGeneration.current || !channels.current.has(channelId)) {
          await closeAgent(channelId).catch(() => {});
          return undefined;
        }
        providerChannels.current.set(key, channelId);
        updateProviderRuntime(nextProvider, activeProviderSessionId, (runtime) => ({
          ...runtime,
          connectionState: "connected",
        }));
        return channelId;
      } catch (reason) {
        if (activeChannel.current === channelId) activeChannel.current = null;
        await closeAgent(channelId).catch(() => {});
        channels.current.delete(channelId);
        decoders.current.delete(channelId);
        claudeNormalizers.current.delete(channelId);
        updateProviderRuntime(nextProvider, activeProviderSessionId, (runtime) => ({
          ...failSessionHistory(runtime),
          connectionState: "disconnected",
        }));
        setProviderError(
          nextProvider,
          reason instanceof Error ? reason.message : String(reason),
        );
        return undefined;
      } finally {
        if (openingProviders.current.get(key) === opening) {
          openingProviders.current.delete(key);
        }
      }
    })();
    openingProviders.current.set(key, opening);
    return opening;
  };

  const connectProfile = async (
    profile: HostProfile,
    auth: SshAuth,
    trustedFingerprint = profile.trustedFingerprint,
    restore?: { provider: Provider; sessionId?: string; cwd?: string },
  ): Promise<void> => {
    const preservingView = restore !== undefined;
    const reconnecting = preservingView
      && connectionStatusRef.current === "connected"
      && currentProfileRef.current?.id === profile.id;
    if (!reconnecting) {
      setConnectionStatus("connecting");
      connectionStatusRef.current = "connecting";
    }
    setPendingTrust(null);
    setError(null);
    try {
      const result = await connectSsh({
        host: profile.host,
        port: profile.port,
        user: profile.user,
        ...(trustedFingerprint ? { trustedFingerprint } : {}),
        auth,
      });
      if (result.trustRequired) {
        setPendingTrust({ profile, auth, fingerprint: result.fingerprint });
        setConnectionStatus("disconnected");
        connectionStatusRef.current = "disconnected";
        return;
      }
      const trustedProfile = { ...profile, trustedFingerprint: result.fingerprint };
      credentialCache.current.set(profile.id, auth);
      rememberProfile(trustedProfile);
      setCurrentProfile(trustedProfile);
      currentProfileRef.current = trustedProfile;
      setForm(formFromProfile(trustedProfile));
      setConnectionStatus("connected");
      connectionStatusRef.current = "connected";
      restoredProfileId.current = trustedProfile.id;
      if (preservingView) resetAgentState(true);
      let credentialSaveError: string | null = null;
      try {
        await saveSshCredential(profile.id, auth);
      } catch (reason) {
        credentialSaveError = `SSH connected, but the credential could not be saved: ${String(reason)}`;
      }
      const channelId = await openProvider(
        trustedProfile,
        restore?.provider ?? providerRef.current,
        restore?.sessionId,
        preservingView,
        restore?.cwd,
      );
      if (credentialSaveError && channelId !== undefined) setError(credentialSaveError);
    } catch (reason) {
      setConnectionStatus("disconnected");
      connectionStatusRef.current = "disconnected";
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    if (MOBILE_DEMO || !initialProfile || initialRestoreStarted.current) return;
    initialRestoreStarted.current = true;
    let disposed = false;
    const restoreInitialProfile = async (): Promise<void> => {
      try {
        const auth = await credentialForProfile(initialProfile.id);
        if (disposed || !auth) return;
        const sessionId = activeSessionRef.current ?? undefined;
        const sessionCwd = sessionsRef.current.find((session) => session.id === sessionId)?.cwd;
        await connectProfile(
          initialProfile,
          auth,
          initialProfile.trustedFingerprint,
          initialView
            ? { provider: initialProvider, sessionId, cwd: sessionCwd }
            : undefined,
        );
      } catch (reason) {
        if (!disposed) setError(`Could not load the saved SSH credential: ${String(reason)}`);
      }
    };
    void restoreInitialProfile();
    return () => {
      disposed = true;
      initialRestoreStarted.current = false;
    };
  }, []);

  const resumeConnection = async (): Promise<void> => {
    if (connectionStatusRef.current !== "connected" || resumeInFlightRef.current) return;
    const profile = currentProfileRef.current;
    if (!profile) return;
    resumeInFlightRef.current = true;
    try {
      const currentProvider = providerRef.current;
      const sessionId = activeSessionRef.current ?? undefined;
      const sessionCwd = sessionsRef.current.find((session) => session.id === sessionId)?.cwd;
      if (await probeSsh()) {
        const channelEntries = [...providerChannels.current.entries()];
        const channelHealth = await Promise.all(channelEntries.map(async ([key, channelId]) => ({
          key,
          channelId,
          alive: await probeAgent(channelId).catch(() => false),
        })));
        const aliveChannels = channelHealth.filter((entry) => entry.alive);
        for (const entry of channelHealth) {
          if (entry.alive) continue;
          providerChannels.current.delete(entry.key);
          const meta = channels.current.get(entry.channelId);
          if (meta?.purpose === "provider" && meta.provider === "codex") {
            codexClient.current?.close();
            codexClient.current = null;
            disconnectProviderRuntimes("codex");
          } else if (meta?.sessionId) {
            updateProviderRuntime(meta.provider, meta.sessionId, (runtime) => ({
              ...runtime,
              activeTurnId: null,
              connectionState: "disconnected",
              running: false,
              waiting: false,
            }));
          }
          channels.current.delete(entry.channelId);
          decoders.current.delete(entry.channelId);
          claudeNormalizers.current.delete(entry.channelId);
        }
        if (aliveChannels.length > 0) {
          const activeKey = providerChannelKey(currentProvider, sessionId);
          const activeHealth = channelHealth.find((entry) => entry.key === activeKey);
          if (!activeHealth) {
            activeChannel.current = null;
            return;
          }
          if (activeHealth.alive) {
            activeChannel.current = activeHealth.channelId;
            return;
          }
          await openProvider(profile, currentProvider, sessionId, true, sessionCwd);
          return;
        }
        resetAgentState(true);
        await openProvider(profile, currentProvider, sessionId, true, sessionCwd);
        return;
      }
      const auth = credentialCache.current.get(profile.id);
      if (!auth) {
        setConnectionStatus("disconnected");
        connectionStatusRef.current = "disconnected";
        setError("SSH connection was lost. Enter the credential to reconnect.");
        return;
      }
      await connectProfile(profile, auth, profile.trustedFingerprint, {
        provider: currentProvider,
        sessionId,
        cwd: sessionCwd,
      });
    } finally {
      resumeInFlightRef.current = false;
    }
  };
  resumeConnectionRef.current = resumeConnection;

  const connectFromForm = async (): Promise<void> => {
    const profile = profileFromForm(form);
    if (!profile.host || !profile.user || !Number.isInteger(profile.port) || profile.port <= 0) {
      setError("Host, user, and port are required.");
      return;
    }
    let auth: SshAuth | undefined;
    try {
      auth = authFromForm(form) ?? await credentialForProfile(profile.id);
    } catch (reason) {
      setError(`Could not load the saved SSH credential: ${String(reason)}`);
      return;
    }
    if (!auth) {
      setError(form.authMode === "password" ? "Enter the SSH password." : "Paste the private key.");
      return;
    }
    const existing = profiles.find((candidate) => candidate.id === profile.id);
    const canRestoreCurrent = restoredProfileId.current === profile.id
      && (sessionsRef.current.length > 0
        || activeSessionRef.current !== null
        || Object.keys(runtimesRef.current).length > 0);
    const cachedView = canRestoreCurrent
      ? undefined
      : loadCachedWorkbenchView(profile.id, providerRef.current);
    if (!canRestoreCurrent) {
      persistWorkbenchRef.current();
      resetAgentState();
      replaceWorkbenchView(cachedView);
      restoredProfileId.current = profile.id;
    }
    const canRestore = canRestoreCurrent || cachedView !== undefined;
    const sessionId = activeSessionRef.current ?? undefined;
    const sessionCwd = sessionsRef.current.find((session) => session.id === sessionId)?.cwd;
    await connectProfile(
      { ...profile, trustedFingerprint: existing?.trustedFingerprint },
      auth,
      existing?.trustedFingerprint,
      canRestore ? { provider: providerRef.current, sessionId, cwd: sessionCwd } : undefined,
    );
  };

  const trustAndConnect = async (): Promise<void> => {
    if (!pendingTrust) return;
    const trustedProfile = {
      ...pendingTrust.profile,
      trustedFingerprint: pendingTrust.fingerprint,
    };
    await connectProfile(trustedProfile, pendingTrust.auth, pendingTrust.fingerprint);
  };

  const switchHost = async (profile: HostProfile): Promise<void> => {
    setHostSheetOpen(false);
    persistWorkbenchRef.current();
    let auth: SshAuth | undefined;
    try {
      auth = await credentialForProfile(profile.id);
    } catch (reason) {
      setError(`Could not load the saved SSH credential: ${String(reason)}`);
    }
    const cachedView = loadCachedWorkbenchView(profile.id, providerRef.current);
    if (!auth) {
      await disconnectSsh().catch(() => {});
      setConnectionStatus("disconnected");
      connectionStatusRef.current = "disconnected";
      setCurrentProfile(null);
      currentProfileRef.current = null;
      activeChannel.current = null;
      resetAgentState();
      replaceWorkbenchView(cachedView);
      restoredProfileId.current = profile.id;
      setForm(formFromProfile(profile));
      return;
    }
    resetAgentState();
    replaceWorkbenchView(cachedView);
    restoredProfileId.current = profile.id;
    const sessionId = activeSessionRef.current ?? undefined;
    const sessionCwd = sessionsRef.current.find((session) => session.id === sessionId)?.cwd;
    await connectProfile(
      profile,
      auth,
      profile.trustedFingerprint,
      cachedView ? { provider: providerRef.current, sessionId, cwd: sessionCwd } : undefined,
    );
  };

  const applyNormalizedEvent = (kind: Provider, event: MobileAgentEvent): void => {
    switch (event.type) {
      case "sessionsLoaded":
        updateProviderView(kind, (view) => ({ ...view, sessions: event.sessions }));
        return;
      case "sessionLoaded":
        if (kind === providerRef.current) {
          pendingSessionScrollRef.current = { sessionId: event.session.id };
        }
        updateProviderView(kind, (view) => ({
          ...view,
          sessions: upsertSession(view.sessions, event.session),
          runtimes: updateSessionRuntime(
            view.runtimes,
            event.session.id,
            (runtime) => completeSessionHistory(runtime, event.items),
          ),
        }));
        return;
      case "sessionStatus":
        updateProviderRuntime(kind, event.sessionId, (runtime) => ({
          ...runtime,
          activeTurnId: event.running
            ? event.turnId ?? runtime.activeTurnId
            : null,
          running: event.running,
          waiting: event.waiting,
        }));
        return;
      case "turnStarted":
        updateProviderRuntime(kind, event.sessionId, (runtime) => ({
          ...runtime,
          activeTurnId: event.turnId,
          running: true,
          waiting: false,
        }));
        return;
      case "turnCompleted": {
        const sessionRuntime = readSessionRuntime(readProviderView(kind).runtimes, event.sessionId);
        const next = sessionRuntime.queue[0];
        updateProviderRuntime(kind, event.sessionId, (runtime) => ({
          ...runtime,
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
                    updateProviderRuntime(kind, event.sessionId, (runtime) => ({
                      ...runtime,
                      queue: runtime.queue[0] === next ? runtime.queue.slice(1) : runtime.queue,
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
        updateProviderRuntime(kind, event.sessionId, (runtime) => ({
          ...runtime,
          items: appendMessageDelta(runtime.items, event.itemId, event.text),
        }));
        return;
      case "userMessage":
        updateProviderRuntime(kind, event.sessionId, (runtime) => ({
          ...runtime,
          items: appendUnique(runtime.items, {
            id: event.itemId,
            kind: "user",
            text: event.text,
          }),
        }));
        return;
      case "messageCompleted":
        updateProviderRuntime(kind, event.sessionId, (runtime) => ({
          ...runtime,
          items: completeMessage(runtime.items, event.itemId, event.text),
        }));
        return;
      case "toolStarted":
        updateProviderRuntime(kind, event.sessionId, (runtime) => ({
          ...runtime,
          items: appendUnique(runtime.items, {
            id: event.itemId,
            kind: "tool",
            title: event.title,
            text: event.detail,
          }),
        }));
        return;
      case "approvalRequested": {
        const request = kind === "codex"
          ? codexClient.current?.resolveApproval(event.requestId, true)
          : undefined;
        if (request) {
          void request.catch((reason) => setProviderError(kind, String(reason)));
          return;
        }
        updateProviderRuntime(kind, event.sessionId, (runtime) => ({
          ...runtime,
          approvals: [
            ...runtime.approvals.filter((approval) => approval.requestId !== event.requestId),
            { requestId: event.requestId, title: event.title, detail: event.detail },
          ],
        }));
        return;
      }
      case "error":
        if (event.sessionId) updateProviderRuntime(kind, event.sessionId, failSessionHistory);
        setProviderError(kind, event.message);
    }
  };
  normalizedHandlerRef.current = applyNormalizedEvent;

  const handleTransport = (event: MobileAgentTransportEvent): void => {
    const meta = channels.current.get(event.channelId);
    if (!meta) return;
    if (
      event.kind === "stderr"
      && activeChannel.current === event.channelId
      && event.data?.trim()
    ) {
      setError(event.data.trim());
      return;
    }
    if (
      event.kind === "exit"
      && activeChannel.current === event.channelId
      && event.exitStatus
      && event.exitStatus !== 0
    ) {
      setError(`Remote agent exited with status ${event.exitStatus}.`);
      return;
    }
    if (event.kind === "closed") {
      const timeout = helperTimeouts.current.get(event.channelId);
      if (timeout) clearTimeout(timeout);
      helperTimeouts.current.delete(event.channelId);
      if (meta.purpose === "claude-history" && !meta.handledPayload) {
        updateProviderRuntime(meta.provider, meta.sessionId, failSessionHistory);
        setProviderError(meta.provider, "Claude session history returned no data.");
      }
      decoders.current.delete(event.channelId);
      claudeNormalizers.current.delete(event.channelId);
      channels.current.delete(event.channelId);
      const key = providerChannelKey(meta.provider, meta.sessionId);
      const ownsRuntime = providerChannels.current.get(key) === event.channelId;
      if (ownsRuntime) {
        providerChannels.current.delete(key);
      }
      if (activeChannel.current === event.channelId) {
        activeChannel.current = providerChannels.current.get(
          providerChannelKey(providerRef.current, activeSessionRef.current),
        ) ?? null;
      }
      if (meta.purpose === "provider" && meta.provider === "codex" && ownsRuntime) {
        codexClient.current?.close();
        codexClient.current = null;
        disconnectProviderRuntimes("codex");
      } else if (meta.purpose === "provider" && ownsRuntime) {
        updateProviderRuntime(meta.provider, meta.sessionId, (runtime) => ({
          ...runtime,
          activeTurnId: null,
          connectionState: "disconnected",
          running: false,
          waiting: false,
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
        codexClient.current?.receive(line);
        continue;
      }
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.type === "wmux_sessions" && Array.isArray(message.sessions)) {
          meta.handledPayload = true;
          const timeout = helperTimeouts.current.get(event.channelId);
          if (timeout) clearTimeout(timeout);
          helperTimeouts.current.delete(event.channelId);
          updateProviderView(meta.provider, (view) => ({
            ...view,
            sessions: message.sessions as MobileSession[],
          }));
          continue;
        }
        const historyEvents = normalizeClaudeHistoryMessage(message, meta.sessionId);
        const normalizedEvents = historyEvents.length > 0
          ? historyEvents
          : claudeNormalizers.current.get(event.channelId)?.receive(message) ?? [];
        if (normalizedEvents.length > 0) meta.handledPayload = true;
        if (normalizedEvents.length > 0 && meta.purpose !== "provider") {
          const timeout = helperTimeouts.current.get(event.channelId);
          if (timeout) clearTimeout(timeout);
          helperTimeouts.current.delete(event.channelId);
        }
        for (const normalized of normalizedEvents) {
          const eventSessionId = normalized.type === "sessionLoaded"
            ? normalized.session.id
            : "sessionId" in normalized
              ? normalized.sessionId
              : undefined;
          if (
            meta.purpose === "provider"
            && eventSessionId
            && eventSessionId !== meta.sessionId
          ) {
            const previousId = meta.sessionId ?? null;
            const previousKey = providerChannelKey("claude", previousId);
            if (providerChannels.current.get(previousKey) === event.channelId) {
              providerChannels.current.delete(previousKey);
            }
            providerChannels.current.set(providerChannelKey("claude", eventSessionId), event.channelId);
            meta.sessionId = eventSessionId;
            updateProviderView("claude", (view) => ({
              ...view,
              activeSessionId: view.activeSessionId === previousId
                ? eventSessionId
                : view.activeSessionId,
              runtimes: moveSessionRuntime(view.runtimes, previousId, eventSessionId),
            }));
          }
          normalizedHandlerRef.current(meta.provider, normalized);
        }
      } catch {
        if (meta.purpose !== "provider") {
          meta.handledPayload = true;
          const timeout = helperTimeouts.current.get(event.channelId);
          if (timeout) clearTimeout(timeout);
          helperTimeouts.current.delete(event.channelId);
          if (meta.purpose === "claude-history") {
            updateProviderRuntime(meta.provider, meta.sessionId, failSessionHistory);
          }
          void closeAgent(event.channelId).catch(() => {});
        }
        setProviderError(meta.provider, "The remote agent returned an invalid JSON line.");
      }
    }
  };
  transportHandlerRef.current = handleTransport;

  const submitText = async (
    text: string,
    fromQueue = false,
    requestedSessionId?: string | null,
    requestedProvider = providerRef.current,
  ): Promise<boolean> => {
    const trimmed = text.trim();
    const profile = currentProfileRef.current;
    if (!trimmed || !profile) return false;
    const kind = requestedProvider;
    const providerView = readProviderView(kind);
    let sessionId = requestedSessionId === undefined
      ? providerView.activeSessionId
      : requestedSessionId;
    let sessionRuntime = readSessionRuntime(providerView.runtimes, sessionId);
    if (sessionRuntime.historyState === "loading") return false;
    const action = fromQueue ? "send" : composerAction(sessionRuntime.running, sessionRuntime.queueMode);
    if (action === "queue") {
      updateProviderRuntime(kind, sessionId, (runtime) => ({
        ...runtime,
        queue: [...runtime.queue, trimmed],
        draft: "",
      }));
      return true;
    }
    setProviderError(kind, null);

    if (kind === "codex") {
      const client = codexClient.current;
      if (!client) {
        setProviderError(kind, "Codex channel is not ready.");
        return false;
      }
      if (!sessionId) {
        try {
          const started = await client.startSession(
            profile.cwd || undefined,
            sessionRuntime.executionSettings,
          );
          const createdSessionId = started.threadId;
          moveProviderRuntime(kind, null, createdSessionId);
          sessionId = createdSessionId;
          updateProviderView(kind, (view) => ({
            ...view,
            activeSessionId: view.activeSessionId === null
              ? createdSessionId
              : view.activeSessionId,
          }));
          sessionRuntime = readSessionRuntime(readProviderView(kind).runtimes, createdSessionId);
          updateProviderRuntime(kind, createdSessionId, (runtime) => ({
            ...runtime,
            executionSettings: resolvedExecutionSettings(
              sessionRuntime.executionSettings,
              started.settings,
            ),
          }));
          sessionRuntime = readSessionRuntime(readProviderView(kind).runtimes, createdSessionId);
        } catch (reason) {
          setProviderError(kind, String(reason));
          return false;
        }
      }
      updateProviderRuntime(kind, sessionId, (runtime) => ({
        ...runtime,
        draft: "",
        items: appendUserMessage(runtime.items, trimmed),
        running: true,
        waiting: false,
        historyState: "loaded",
      }));
      try {
        if (action === "steer" && sessionRuntime.activeTurnId) {
          await client.steer(sessionId, sessionRuntime.activeTurnId, trimmed);
        } else {
          await client.startTurn(
            sessionId,
            trimmed,
            profile.cwd || undefined,
            sessionRuntime.executionSettings,
          );
        }
      } catch (reason) {
        if (action !== "steer") {
          updateProviderRuntime(kind, sessionId, (runtime) => ({
            ...runtime,
            running: false,
            waiting: false,
          }));
        }
        setProviderError(kind, String(reason));
        return false;
      }
      return true;
    }

    let channelId = providerChannels.current.get(providerChannelKey(kind, sessionId));
    const channelMeta = channelId ? channels.current.get(channelId) : undefined;
    if (
      channelId
      && action === "send"
      && !sameClaudeLaunchSettings(channelMeta?.launchSettings, sessionRuntime.executionSettings)
    ) {
      providerChannels.current.delete(providerChannelKey(kind, sessionId));
      await closeAgent(channelId).catch(() => {});
      if (activeChannel.current === channelId) activeChannel.current = null;
      const cwd = readProviderView(kind).sessions.find((session) => session.id === sessionId)?.cwd;
      channelId = await openProvider(
        profile,
        "claude",
        sessionId ?? undefined,
        true,
        cwd,
        kind === providerRef.current,
      ) ?? undefined;
    }
    if (!channelId && kind === providerRef.current) {
      channelId = await openProvider(profile, "claude", sessionId ?? undefined) ?? undefined;
    }
    if (!channelId) return false;
    updateProviderRuntime(kind, sessionId, (runtime) => ({
      ...runtime,
      draft: "",
      items: appendUserMessage(runtime.items, trimmed),
      running: true,
      waiting: false,
      historyState: "loaded",
    }));
    try {
      await writeAgentLine(channelId, claudeInput(trimmed));
      return true;
    } catch (reason) {
      updateProviderRuntime(kind, sessionId, (runtime) => ({
        ...runtime,
        running: false,
        waiting: false,
      }));
      setProviderError(kind, String(reason));
      return false;
    }
  };
  submitRef.current = (kind, sessionId, text, fromQueue) =>
    submitText(text, fromQueue, sessionId, kind);

  const stopTurn = async (): Promise<void> => {
    const kind = providerRef.current;
    const providerView = readProviderView(kind);
    const sessionId = providerView.activeSessionId;
    const sessionRuntime = readSessionRuntime(providerView.runtimes, sessionId);
    if (!sessionRuntime.running) return;
    if (kind === "codex") {
      const turnId = sessionRuntime.activeTurnId;
      if (sessionId && turnId) await codexClient.current?.interrupt(sessionId, turnId);
    } else {
      const key = providerChannelKey("claude", sessionId);
      const channelId = providerChannels.current.get(key);
      if (channelId) {
        providerChannels.current.delete(key);
        await closeAgent(channelId).catch(() => {});
        if (activeChannel.current === channelId) activeChannel.current = null;
      }
    }
    updateProviderRuntime(kind, sessionId, (runtime) => ({
      ...runtime,
      activeTurnId: null,
      connectionState: kind === "claude" ? "idle" : runtime.connectionState,
      running: false,
      waiting: false,
    }));
  };

  const selectSession = async (session: MobileSession): Promise<void> => {
    const kind = providerRef.current;
    const providerView = readProviderView(kind);
    setSessionSheetOpen(false);
    setSettingsSheetOpen(false);
    const selectedRuntime = readSessionRuntime(providerView.runtimes, session.id);
    const shouldReconnect = selectedRuntime.connectionState === "disconnected";
    updateProviderView(kind, (view) => ({ ...view, activeSessionId: session.id }));
    const shouldLoadHistory = selectedRuntime.historyState === "idle";
    if (shouldLoadHistory) {
      updateProviderRuntime(kind, session.id, (runtime) => beginSessionHistory(runtime, session.id));
    }
    const profile = currentProfileRef.current;
    if (!profile) return;
    try {
      if (
        shouldReconnect
        || (kind === "codex" && !codexClient.current)
      ) {
        await openProvider(profile, kind, session.id, true, session.cwd);
        return;
      }
      if (kind === "codex") {
        if (shouldLoadHistory) {
          const settings = await codexClient.current?.resumeSession(session.id);
          if (settings) {
            updateProviderRuntime(kind, session.id, (runtime) => ({
              ...runtime,
              executionSettings: settings,
            }));
          }
        }
        return;
      }
      if (shouldLoadHistory) await requestClaudeData(session.id);
    } catch (reason) {
      updateProviderRuntime(kind, session.id, failSessionHistory);
      setProviderError(kind, String(reason));
    }
  };

  const newSession = async (): Promise<void> => {
    const kind = providerRef.current;
    const profile = currentProfileRef.current;
    if (!profile) return;
    setSessionSheetOpen(false);
    setSettingsSheetOpen(false);
    updateProviderView(kind, (view) => ({
      ...view,
      activeSessionId: null,
      runtimes: {
        ...view.runtimes,
        [sessionRuntimeKey(null)]: createSessionRuntime(),
      },
    }));
    if (kind === "codex") {
      try {
        const newRuntime = readSessionRuntime(readProviderView(kind).runtimes, null);
        const started = await codexClient.current?.startSession(
          profile.cwd || undefined,
          newRuntime.executionSettings,
        );
        if (started) {
          moveProviderRuntime(kind, null, started.threadId);
          updateProviderRuntime(kind, started.threadId, (runtime) => ({
            ...runtime,
            executionSettings: resolvedExecutionSettings(
              runtime.executionSettings,
              started.settings,
            ),
          }));
          updateProviderView(kind, (view) => ({
            ...view,
            activeSessionId: view.activeSessionId === null ? started.threadId : view.activeSessionId,
          }));
        }
      } catch (reason) {
        setProviderError(kind, String(reason));
      }
    } else {
      await openProvider(profile, kind);
    }
  };

  const changeProvider = async (nextProvider: Provider): Promise<void> => {
    if (nextProvider === providerRef.current) return;
    const profile = currentProfileRef.current;
    if (!profile) return;
    if (nextProvider === "claude") {
      await prepareProvider(nextProvider);
      const sessionId = activeSessionRef.current ?? undefined;
      const claudeView = readProviderView("claude");
      const claudeRuntime = readSessionRuntime(claudeView.runtimes, sessionId);
      if (sessionId && claudeRuntime.connectionState === "disconnected") {
        const sessionCwd = claudeView.sessions.find((session) => session.id === sessionId)?.cwd;
        await openProvider(profile, "claude", sessionId, true, sessionCwd);
        return;
      }
      const shouldRequestClaudeData = sessionId
        ? claudeRuntime.historyState === "idle"
        : claudeView.sessions.length === 0;
      if (shouldRequestClaudeData) await requestClaudeData(sessionId);
      return;
    }
    await openProvider(profile, nextProvider);
  };

  const resolveApproval = async (approval: AgentApprovalRequest, accepted: boolean): Promise<void> => {
    const kind = providerRef.current;
    const sessionId = readProviderView(kind).activeSessionId;
    try {
      await codexClient.current?.resolveApproval(approval.requestId, accepted);
      updateProviderRuntime(kind, sessionId, (runtime) => ({
        ...runtime,
        approvals: runtime.approvals.filter((item) => item.requestId !== approval.requestId),
      }));
    } catch (reason) {
      setProviderError(kind, String(reason));
    }
  };

  const filteredSessions = useMemo(() => {
    const search = sessionSearch.trim().toLowerCase();
    return search
      ? sessions.filter((session) =>
          `${session.title} ${session.cwd ?? ""}`.toLowerCase().includes(search))
      : sessions;
  }, [sessionSearch, sessions]);

  const applyExecutionSettings = async (settings: AgentExecutionSettings): Promise<void> => {
    const kind = providerRef.current;
    const providerView = readProviderView(kind);
    const sessionId = providerView.activeSessionId;
    const previousSettings = readSessionRuntime(providerView.runtimes, sessionId).executionSettings;
    updateProviderRuntime(kind, sessionId, (runtime) => ({ ...runtime, executionSettings: settings }));
    try {
      if (kind === "codex") {
        if (sessionId) await codexClient.current?.updateSessionSettings(sessionId, settings);
      }
    } catch (reason) {
      updateProviderRuntime(kind, sessionId, (runtime) => ({
        ...runtime,
        executionSettings: previousSettings,
      }));
      setProviderError(kind, reason instanceof Error ? reason.message : String(reason));
    }
  };

  if (connectionStatus !== "connected" || !currentProfile) {
    return (
      <ConnectionView
        profiles={profiles}
        form={form}
        setForm={setForm}
        status={connectionStatus}
        error={error}
        pendingTrust={pendingTrust}
        onConnect={() => void connectFromForm()}
        onTrust={() => void trustAndConnect()}
        onSelectProfile={(profile) => setForm(formFromProfile(profile))}
        onNewProfile={() => setForm(blankForm())}
      />
    );
  }

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const action = composerAction(running, runtime.queueMode);
  const threadSettings = runtime.executionSettings;
  const selectedCodexModel = codexModels.find((model) =>
    model.model === threadSettings.model || model.id === threadSettings.model)
    ?? codexModels.find((model) => model.isDefault);
  const effortOptions = provider === "codex"
    ? selectedCodexModel?.supportedReasoningEfforts ?? []
    : [...CLAUDE_EFFORTS];
  const serviceTierOptions = selectedCodexModel?.serviceTiers ?? [];
  const modelLabel = provider === "codex"
    ? selectedCodexModel?.displayName ?? threadSettings.model ?? "Default"
    : threadSettings.model ?? "Default";
  const effortLabel = threadSettings.effort ?? selectedCodexModel?.defaultReasoningEffort ?? "Default";
  const serviceTierLabel = serviceTierOptions.find((tier) => tier.id === threadSettings.serviceTier)?.name
    ?? (threadSettings.serviceTier ? threadSettings.serviceTier : "Standard");
  const codexActivity = activeSessionCount(readProviderView("codex").runtimes);
  const claudeActivity = activeSessionCount(readProviderView("claude").runtimes);

  return (
    <div className="mobile-app">
      <header className="mobile-header">
        <button className="host-pill" type="button" onClick={() => setHostSheetOpen(true)}>
          <span className="online-dot" aria-hidden="true" />
          <span className="host-pill-copy">
            <strong>{currentProfile.name}</strong>
            <small>{currentProfile.user}@{currentProfile.host}</small>
          </span>
          <ChevronDown />
        </button>
        <div className="provider-switch" aria-label="Agent provider">
          <button
            type="button"
            className={provider === "codex" ? "active" : ""}
            onClick={() => void changeProvider("codex")}
          >Codex{codexActivity > 0 ? <span className="provider-count">{codexActivity}</span> : null}</button>
          <button
            type="button"
            className={provider === "claude" ? "active" : ""}
            onClick={() => void changeProvider("claude")}
          >Claude{claudeActivity > 0 ? <span className="provider-count">{claudeActivity}</span> : null}</button>
        </div>
      </header>

      <nav className="session-strip" aria-label="Recent sessions">
        <button className="new-session-button" type="button" onClick={() => void newSession()} aria-label="New session">+</button>
        <div className="recent-sessions">
          {sessions.slice(0, 5).map((session) => {
            const sessionRuntime = readSessionRuntime(runtimes, session.id);
            const sessionLabel = sessionRuntimeLabel(sessionRuntime);
            const updated = relativeTime(session.updatedAt);
            return (
              <button
                type="button"
                key={session.id}
                className={session.id === activeSessionId ? "session-chip active" : "session-chip"}
                onClick={() => void selectSession(session)}
              >
                <span>{session.title}</span>
                <small className={sessionLabel.toLowerCase()}>
                  <span className={`session-state-dot ${sessionLabel.toLowerCase()}`} aria-hidden="true" />
                  {sessionLabel}{updated ? ` · ${updated}` : ""}
                </small>
              </button>
            );
          })}
          {sessions.length === 0 ? <span className="session-empty">No saved sessions</span> : null}
        </div>
        <button className="all-sessions-button" type="button" onClick={() => setSessionSheetOpen(true)} aria-label="All sessions">
          <MenuIcon />
        </button>
      </nav>

      <main ref={timelineRef} className="activity-timeline" aria-live="polite">
        <section className="session-context">
          <div className="session-heading">
            <div>
              <span className="eyebrow">{provider}</span>
              <h1>{activeSession?.title ?? "New session"}</h1>
            </div>
            <span className={running ? "run-state running" : "run-state"}>
              {sessionRuntimeLabel(runtime)}
            </span>
          </div>
          <button
            type="button"
            className="execution-summary"
            onClick={() => setSettingsSheetOpen(true)}
          >
            <span><b>Model</b>{modelLabel}</span>
            <span><b>Effort</b>{effortLabel}</span>
            {provider === "codex" ? <span><b>Speed</b>{serviceTierLabel}</span> : null}
            <span className="execution-summary-arrow" aria-hidden="true">›</span>
          </button>
        </section>

        {error ? (
          <div className="inline-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)}>Dismiss</button>
          </div>
        ) : null}

        {items.length === 0 && approvals.length === 0 ? (
          <div className="empty-workbench">
            <h2>Send the next instruction</h2>
            <p>Output is rendered as messages and tool activity. The raw SSH terminal stays hidden.</p>
          </div>
        ) : null}

        {items.map((item) => <TimelineRow key={item.id} item={item} />)}

        {approvals.map((approval) => (
          <article className="approval-row" key={approval.requestId}>
            <div className="timeline-rail approval" />
            <div className="timeline-content">
              <span className="timeline-label">Approval required</span>
              <strong>{approval.title}</strong>
              {approval.detail ? <pre>{approval.detail}</pre> : null}
              <div className="approval-actions">
                <button type="button" className="deny" onClick={() => void resolveApproval(approval, false)}>Deny</button>
                <button type="button" className="approve" onClick={() => void resolveApproval(approval, true)}>Approve once</button>
              </div>
            </div>
          </article>
        ))}

        {running ? (
          <div className="working-indicator">
            <span /><span /><span />
            <span>Agent is working</span>
          </div>
        ) : null}
      </main>

      {queue.length > 0 ? (
        <aside className="queue-preview">
          <span>{queue.length} queued</span>
          <p>{queue[0]}</p>
          <button type="button" onClick={() => updateRuntime(activeSessionId, (runtime) => ({ ...runtime, queue: [] }))}>Clear</button>
        </aside>
      ) : null}

      <footer className={action === "steer" ? "mobile-composer steering" : "mobile-composer"}>
        <textarea
          value={runtime.draft}
          onChange={(event) => updateRuntime(activeSessionId, (current) => ({
            ...current,
            draft: event.target.value,
          }))}
          placeholder={action === "steer" ? "Redirect the active task…" : action === "queue" ? "Add the next instruction…" : "Message the agent…"}
          rows={1}
          aria-label="Agent instruction"
        />
        <div className="composer-actions">
          <div className="composer-mode">
            {running ? (
              <button
                type="button"
                className={runtime.queueMode ? "" : "active"}
                onClick={() => updateRuntime(activeSessionId, (current) => ({ ...current, queueMode: false }))}
              >Steer</button>
            ) : null}
            {running ? (
              <button
                type="button"
                className={runtime.queueMode ? "active" : ""}
                onClick={() => updateRuntime(activeSessionId, (current) => ({ ...current, queueMode: true }))}
              >Queue</button>
            ) : <span>Enter adds a new line</span>}
          </div>
          <div className="composer-buttons">
            {running ? <button type="button" className="stop-button" onClick={() => void stopTurn()}>Stop</button> : null}
            <button
              type="button"
              className="send-button"
              disabled={
                !runtime.draft.trim()
                || runtime.historyState === "loading"
                || (provider === "codex" && running && !runtime.activeTurnId && !runtime.queueMode)
              }
              onClick={() => void submitText(runtime.draft)}
            >{action === "send" ? "Send" : action === "steer" ? "Steer" : "Queue"}</button>
          </div>
        </div>
      </footer>

      {hostSheetOpen ? (
        <BottomSheet title="Hosts" onClose={() => setHostSheetOpen(false)}>
          <div className="sheet-list">
            {profiles.map((profile) => (
              <button type="button" key={profile.id} onClick={() => void switchHost(profile)}>
                <span className={profile.id === currentProfile.id ? "online-dot" : "host-dot"} />
                <span><strong>{profile.name}</strong><small>{profile.user}@{profile.host}:{profile.port}</small></span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="sheet-secondary"
            onClick={() => {
              setHostSheetOpen(false);
              void disconnectSsh();
              setConnectionStatus("disconnected");
              connectionStatusRef.current = "disconnected";
              setCurrentProfile(null);
              currentProfileRef.current = null;
              setForm(blankForm());
            }}
          >Add host</button>
        </BottomSheet>
      ) : null}

      {sessionSheetOpen ? (
        <BottomSheet title={`${provider} sessions`} onClose={() => setSessionSheetOpen(false)}>
          <input
            className="session-search"
            type="search"
            value={sessionSearch}
            onChange={(event) => setSessionSearch(event.target.value)}
            placeholder="Search sessions"
            autoFocus
          />
          <button type="button" className="sheet-secondary" onClick={() => void newSession()}>New session</button>
          <div className="sheet-list session-list">
            {filteredSessions.map((session) => {
              const sessionRuntime = readSessionRuntime(runtimes, session.id);
              const sessionLabel = sessionRuntimeLabel(sessionRuntime);
              return (
                <button type="button" key={session.id} onClick={() => void selectSession(session)}>
                  <span className={`session-state-dot ${sessionLabel.toLowerCase()}`} />
                  <span>
                    <strong>{session.title}</strong>
                    <small>{session.cwd || session.id} · {sessionLabel} · {relativeTime(session.updatedAt)}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </BottomSheet>
      ) : null}

      {settingsSheetOpen ? (
        <BottomSheet title={`${provider} session settings`} onClose={() => setSettingsSheetOpen(false)}>
          <div className="execution-settings">
            <label>
              <span>Model</span>
              <select
                value={threadSettings.model ?? ""}
                disabled={provider === "claude" && running}
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
                <option value="">Default</option>
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
                disabled={provider === "claude" && running}
                onChange={(event) => void applyExecutionSettings({
                  ...threadSettings,
                  effort: event.target.value || null,
                })}
              >
                <option value="">Default</option>
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
                  {serviceTierOptions.map((tier) => <option key={tier.id} value={tier.id}>{tier.name}</option>)}
                </select>
              </label>
            ) : (
              <div className="unsupported-setting">
                <span>Speed</span>
                <small>Claude CLI does not expose a speed setting.</small>
              </div>
            )}
            {provider === "claude" && running
              ? <p className="settings-note">Stop or wait for this turn before changing Claude model or effort.</p>
              : provider === "claude"
                ? <p className="settings-note neutral">Model and effort apply when the next message starts.</p>
                : null}
          </div>
        </BottomSheet>
      ) : null}
    </div>
  );
};

const upsertSession = (sessions: MobileSession[], session: MobileSession): MobileSession[] => {
  const remaining = sessions.filter((candidate) => candidate.id !== session.id);
  return [session, ...remaining];
};

const appendUnique = (items: MobileTimelineItem[], item: MobileTimelineItem): MobileTimelineItem[] =>
  items.some((candidate) => candidate.id === item.id) ? items : [...items, item];

const appendMessageDelta = (
  items: MobileTimelineItem[],
  id: string,
  delta: string,
): MobileTimelineItem[] => {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return [...items, { id, kind: "assistant", text: delta }];
  return items.map((item) => item.id === id ? { ...item, text: item.text + delta } : item);
};

const completeMessage = (
  items: MobileTimelineItem[],
  id: string | undefined,
  text: string,
): MobileTimelineItem[] => {
  if (id && items.some((item) => item.id === id)) {
    return items.map((item) => item.id === id ? { ...item, text } : item);
  }
  return [...items, { id: id ?? `assistant-${Date.now()}-${items.length}`, kind: "assistant", text }];
};

const appendUserMessage = (
  items: MobileTimelineItem[],
  text: string,
): MobileTimelineItem[] => [
  ...items,
  { id: `user-${Date.now()}-${items.length}`, kind: "user", text },
];

const TimelineRow = ({ item }: { item: MobileTimelineItem }) => (
  <article className={`timeline-row ${item.kind}`}>
    <div className={`timeline-rail ${item.kind}`} />
    <div className="timeline-content">
      <span className="timeline-label">
        {item.kind === "user" ? "You" : item.kind === "assistant" ? "Agent" : item.title ?? "Status"}
      </span>
      {item.kind === "tool" ? <pre>{item.text}</pre> : <p>{item.text}</p>}
    </div>
  </article>
);

interface ConnectionViewProps {
  profiles: HostProfile[];
  form: ConnectionForm;
  setForm: React.Dispatch<React.SetStateAction<ConnectionForm>>;
  status: ConnectionStatus;
  error: string | null;
  pendingTrust: PendingTrust | null;
  onConnect: () => void;
  onTrust: () => void;
  onSelectProfile: (profile: HostProfile) => void;
  onNewProfile: () => void;
}

const ConnectionView = ({
  profiles,
  form,
  setForm,
  status,
  error,
  pendingTrust,
  onConnect,
  onTrust,
  onSelectProfile,
  onNewProfile,
}: ConnectionViewProps) => {
  const update = (key: keyof ConnectionForm, value: string) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  return (
    <main className="connect-screen">
      <div className="connect-scroll">
        <header className="connect-brand">
          <span className="brand-mark">w</span>
          <div><strong>wmux</strong><small>Remote agent workbench</small></div>
        </header>

        {profiles.length > 0 ? (
          <section className="saved-hosts">
            <div className="section-heading"><span>Saved hosts</span><button type="button" onClick={onNewProfile}>New</button></div>
            <div className="saved-host-strip">
              {profiles.map((profile) => (
                <button
                  type="button"
                  key={profile.id}
                  className={profile.id === form.id ? "active" : ""}
                  onClick={() => onSelectProfile(profile)}
                >
                  <strong>{profile.name}</strong>
                  <small>{profile.host}</small>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section className="connect-form">
          <div className="section-heading"><span>SSH connection</span><small>Secrets use Android Keystore</small></div>
          <label>Profile name<input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Build server" /></label>
          <div className="field-pair host-port">
            <label>Host<input value={form.host} onChange={(event) => update("host", event.target.value)} placeholder="192.168.0.9" inputMode="url" autoCapitalize="none" /></label>
            <label>Port<input value={form.port} onChange={(event) => update("port", event.target.value)} inputMode="numeric" /></label>
          </div>
          <label>User<input value={form.user} onChange={(event) => update("user", event.target.value)} placeholder="username" autoCapitalize="none" autoComplete="username" /></label>
          <label>Working directory<input value={form.cwd} onChange={(event) => update("cwd", event.target.value)} placeholder="/home/me/Projects/app" autoCapitalize="none" /></label>

          <div className="auth-switch" aria-label="SSH authentication">
            <button type="button" className={form.authMode === "password" ? "active" : ""} onClick={() => update("authMode", "password")}>Password</button>
            <button type="button" className={form.authMode === "privateKey" ? "active" : ""} onClick={() => update("authMode", "privateKey")}>Private key</button>
          </div>

          {form.authMode === "password" ? (
            <label>Password<input type="password" value={form.password} onChange={(event) => update("password", event.target.value)} autoComplete="current-password" /></label>
          ) : (
            <>
              <label>OpenSSH private key<textarea value={form.privateKey} onChange={(event) => update("privateKey", event.target.value)} rows={5} autoCapitalize="none" spellCheck={false} /></label>
              <label>Key passphrase<input type="password" value={form.passphrase} onChange={(event) => update("passphrase", event.target.value)} /></label>
            </>
          )}

          {error ? <div className="connect-error" role="alert">{error}</div> : null}

          {pendingTrust ? (
          <div className="trust-panel">
            <strong>Verify this host key</strong>
            <code>{pendingTrust.fingerprint}</code>
            <p>Compare this SHA-256 fingerprint with the server before trusting it.</p>
          </div>
          ) : null}
        </section>
      </div>

      <footer className="connect-footer">
        <button
          type="button"
          className="connect-button"
          disabled={status === "connecting"}
          onClick={pendingTrust ? onTrust : onConnect}
        >
          {status === "connecting" ? "Connecting…" : pendingTrust ? "Trust and connect" : "Connect"}
        </button>
      </footer>
    </main>
  );
};

const BottomSheet = ({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) => (
  <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="bottom-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <div className="sheet-handle" />
      <header><h2>{title}</h2><button type="button" onClick={onClose}>Close</button></header>
      {children}
    </section>
  </div>
);

const ChevronDown = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
);

const MenuIcon = () => (
  <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M3 5h12M3 9h12M3 13h12" /></svg>
);
