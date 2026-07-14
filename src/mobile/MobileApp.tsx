import { useEffect, useMemo, useRef, useState } from "react";
import { CodexMobileClient } from "./codexMobileClient.ts";
import {
  JsonLineDecoder,
  composerAction,
  normalizeClaudeMessage,
  type MobileAgentEvent,
  type MobileSession,
  type MobileTimelineItem,
} from "./agentProtocol.ts";
import {
  closeAgent,
  connectSsh,
  disconnectSsh,
  listClaudeSessions,
  onAgentTransport,
  openAgent,
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

interface ApprovalRequest {
  requestId: string | number;
  title: string;
  detail: string;
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

export const MobileApp = () => {
  const initialProfiles = useRef(MOBILE_DEMO ? [DEMO_PROFILE] : loadHostProfiles()).current;
  const [profiles, setProfiles] = useState(initialProfiles);
  const [form, setForm] = useState<ConnectionForm>(() =>
    initialProfiles[0] ? formFromProfile(initialProfiles[0]) : blankForm());
  const [currentProfile, setCurrentProfile] = useState<HostProfile | null>(MOBILE_DEMO ? DEMO_PROFILE : null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(MOBILE_DEMO ? "connected" : "disconnected");
  const [pendingTrust, setPendingTrust] = useState<PendingTrust | null>(null);
  const [provider, setProvider] = useState<Provider>("codex");
  const [sessions, setSessions] = useState<MobileSession[]>(MOBILE_DEMO ? DEMO_SESSIONS : []);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(MOBILE_DEMO ? "demo-1" : null);
  const [items, setItems] = useState<MobileTimelineItem[]>(MOBILE_DEMO ? DEMO_ITEMS : []);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(MOBILE_DEMO ? "demo-turn" : null);
  const [running, setRunning] = useState(MOBILE_DEMO);
  const [queueMode, setQueueMode] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [approvals, setApprovals] = useState<ApprovalRequest[]>(MOBILE_DEMO ? [{ requestId: "demo-approval", title: "cargo test", detail: "Run the Rust test suite" }] : []);
  const [error, setError] = useState<string | null>(null);
  const [hostSheetOpen, setHostSheetOpen] = useState(false);
  const [sessionSheetOpen, setSessionSheetOpen] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");

  const credentialCache = useRef(new Map<string, SshAuth>());
  const decoders = useRef(new Map<string, JsonLineDecoder>());
  const codexClient = useRef<CodexMobileClient | null>(null);
  const activeChannel = useRef<string | null>(null);
  const currentProfileRef = useRef<HostProfile | null>(null);
  const providerRef = useRef<Provider>(provider);
  const activeSessionRef = useRef<string | null>(null);
  const activeTurnRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const queueRef = useRef<string[]>([]);
  const normalizedHandlerRef = useRef<(event: MobileAgentEvent) => void>(() => {});
  const transportHandlerRef = useRef<(event: MobileAgentTransportEvent) => void>(() => {});
  const submitRef = useRef<(text: string, fromQueue?: boolean) => Promise<void>>(async () => {});

  useEffect(() => { providerRef.current = provider; }, [provider]);
  useEffect(() => { currentProfileRef.current = currentProfile; }, [currentProfile]);
  useEffect(() => { activeSessionRef.current = activeSessionId; }, [activeSessionId]);
  useEffect(() => { activeTurnRef.current = activeTurnId; }, [activeTurnId]);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { queueRef.current = queue; }, [queue]);

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

  const rememberProfile = (profile: HostProfile): void => {
    setProfiles((previous) => {
      const next = upsertHostProfile(previous, profile);
      saveHostProfiles(next);
      return next;
    });
  };

  const resetAgentState = (): void => {
    codexClient.current?.close("Provider changed");
    codexClient.current = null;
    setSessions([]);
    setActiveSessionId(null);
    activeSessionRef.current = null;
    setItems([]);
    setApprovals([]);
    setQueue([]);
    queueRef.current = [];
    setRunning(false);
    runningRef.current = false;
    setActiveTurnId(null);
    activeTurnRef.current = null;
  };

  const openProvider = async (
    profile: HostProfile,
    nextProvider: Provider,
    sessionId?: string,
  ): Promise<string | undefined> => {
    const previousChannel = activeChannel.current;
    if (previousChannel) await closeAgent(previousChannel).catch(() => {});
    resetAgentState();
    setProvider(nextProvider);
    providerRef.current = nextProvider;
    setError(null);

    const channelId = `${nextProvider}-${Date.now()}`;
    activeChannel.current = channelId;
    decoders.current.set(channelId, new JsonLineDecoder());
    try {
      await openAgent(channelId, nextProvider, sessionId, profile.cwd || undefined);
      if (nextProvider === "codex") {
        const client = new CodexMobileClient(
          (line) => writeAgentLine(channelId, line),
          (event) => normalizedHandlerRef.current(event),
        );
        codexClient.current = client;
        void client.initialize().catch((reason) => setError(String(reason)));
      } else {
        const listChannel = `claude-sessions-${Date.now()}`;
        decoders.current.set(listChannel, new JsonLineDecoder());
        void listClaudeSessions(listChannel).catch((reason) => setError(String(reason)));
        if (sessionId) {
          setActiveSessionId(sessionId);
          activeSessionRef.current = sessionId;
          setItems([{ id: `resume-${sessionId}`, kind: "status", text: "Session resumed" }]);
        }
      }
      return channelId;
    } catch (reason) {
      if (activeChannel.current === channelId) activeChannel.current = null;
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    }
  };

  const connectProfile = async (
    profile: HostProfile,
    auth: SshAuth,
    trustedFingerprint = profile.trustedFingerprint,
  ): Promise<void> => {
    setConnectionStatus("connecting");
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
        return;
      }
      const trustedProfile = { ...profile, trustedFingerprint: result.fingerprint };
      credentialCache.current.set(profile.id, auth);
      rememberProfile(trustedProfile);
      setCurrentProfile(trustedProfile);
      currentProfileRef.current = trustedProfile;
      setForm(formFromProfile(trustedProfile));
      setConnectionStatus("connected");
      void openProvider(trustedProfile, providerRef.current);
    } catch (reason) {
      setConnectionStatus("disconnected");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const connectFromForm = async (): Promise<void> => {
    const profile = profileFromForm(form);
    const auth = authFromForm(form);
    if (!profile.host || !profile.user || !Number.isInteger(profile.port) || profile.port <= 0) {
      setError("Host, user, and port are required.");
      return;
    }
    if (!auth) {
      setError(form.authMode === "password" ? "Enter the SSH password." : "Paste the private key.");
      return;
    }
    const existing = profiles.find((candidate) => candidate.id === profile.id);
    await connectProfile({ ...profile, trustedFingerprint: existing?.trustedFingerprint }, auth);
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
    const auth = credentialCache.current.get(profile.id);
    if (!auth) {
      await disconnectSsh().catch(() => {});
      setConnectionStatus("disconnected");
      setCurrentProfile(null);
      currentProfileRef.current = null;
      activeChannel.current = null;
      resetAgentState();
      setForm(formFromProfile(profile));
      return;
    }
    await connectProfile(profile, auth);
  };

  const applyNormalizedEvent = (event: MobileAgentEvent): void => {
    switch (event.type) {
      case "sessionsLoaded":
        setSessions(event.sessions);
        return;
      case "sessionLoaded":
        setActiveSessionId(event.session.id);
        activeSessionRef.current = event.session.id;
        setItems(event.items);
        setSessions((previous) => upsertSession(previous, event.session));
        return;
      case "turnStarted":
        setActiveSessionId(event.sessionId);
        activeSessionRef.current = event.sessionId;
        setActiveTurnId(event.turnId);
        activeTurnRef.current = event.turnId;
        setRunning(true);
        runningRef.current = true;
        return;
      case "turnCompleted": {
        setRunning(false);
        runningRef.current = false;
        setActiveTurnId(null);
        activeTurnRef.current = null;
        const next = queueRef.current[0];
        if (next) {
          const remaining = queueRef.current.slice(1);
          queueRef.current = remaining;
          setQueue(remaining);
          setTimeout(() => void submitRef.current(next, true), 0);
        }
        return;
      }
      case "messageDelta":
        setItems((previous) => appendMessageDelta(previous, event.itemId, event.text));
        return;
      case "messageCompleted":
        setItems((previous) => completeMessage(previous, event.itemId, event.text));
        if (event.sessionId) {
          setActiveSessionId(event.sessionId);
          activeSessionRef.current = event.sessionId;
        }
        return;
      case "toolStarted":
        setItems((previous) => appendUnique(previous, {
          id: event.itemId,
          kind: "tool",
          title: event.title,
          text: event.detail,
        }));
        return;
      case "approvalRequested":
        setApprovals((previous) => [
          ...previous,
          { requestId: event.requestId, title: event.title, detail: event.detail },
        ]);
        return;
      case "error":
        setError(event.message);
    }
  };
  normalizedHandlerRef.current = applyNormalizedEvent;

  const handleTransport = (event: MobileAgentTransportEvent): void => {
    if (event.kind === "stderr" && event.data?.trim()) {
      setError(event.data.trim());
      return;
    }
    if (event.kind === "exit" && event.exitStatus && event.exitStatus !== 0) {
      setError(`Remote agent exited with status ${event.exitStatus}.`);
      return;
    }
    if (event.kind === "closed") {
      decoders.current.delete(event.channelId);
      if (activeChannel.current === event.channelId) {
        codexClient.current?.close();
        activeChannel.current = null;
        setRunning(false);
        runningRef.current = false;
      }
      return;
    }
    if (event.kind !== "stdout" || !event.data) return;
    const decoder = decoders.current.get(event.channelId) ?? new JsonLineDecoder();
    decoders.current.set(event.channelId, decoder);
    for (const line of decoder.push(event.data)) {
      if (event.channelId.startsWith("codex-")) {
        codexClient.current?.receive(line);
        continue;
      }
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.type === "wmux_sessions" && Array.isArray(message.sessions)) {
          setSessions(message.sessions as MobileSession[]);
          continue;
        }
        for (const normalized of normalizeClaudeMessage(message)) {
          normalizedHandlerRef.current(normalized);
        }
      } catch {
        setError("The remote agent returned an invalid JSON line.");
      }
    }
  };
  transportHandlerRef.current = handleTransport;

  const submitText = async (text: string, fromQueue = false): Promise<void> => {
    const trimmed = text.trim();
    const profile = currentProfileRef.current;
    if (!trimmed || !profile) return;
    const action = fromQueue ? "send" : composerAction(runningRef.current, queueMode);
    if (action === "queue") {
      const next = [...queueRef.current, trimmed];
      queueRef.current = next;
      setQueue(next);
      setDraft("");
      return;
    }
    setError(null);
    setDraft("");

    if (providerRef.current === "codex") {
      const client = codexClient.current;
      if (!client) {
        setError("Codex channel is not ready.");
        return;
      }
      let sessionId = activeSessionRef.current;
      if (!sessionId) {
        try {
          sessionId = await client.startSession(profile.cwd || undefined);
          setActiveSessionId(sessionId);
          activeSessionRef.current = sessionId;
        } catch (reason) {
          setError(String(reason));
          return;
        }
      }
      appendUserMessage(trimmed, setItems);
      setRunning(true);
      runningRef.current = true;
      try {
        if (action === "steer" && activeTurnRef.current) {
          await client.steer(sessionId, activeTurnRef.current, trimmed);
        } else {
          await client.startTurn(sessionId, trimmed, profile.cwd || undefined);
        }
      } catch (reason) {
        setRunning(false);
        runningRef.current = false;
        setError(String(reason));
      }
      return;
    }

    let channelId = activeChannel.current;
    if (!channelId) {
      channelId = await openProvider(profile, "claude", activeSessionRef.current ?? undefined) ?? null;
    }
    if (!channelId) return;
    appendUserMessage(trimmed, setItems);
    setRunning(true);
    runningRef.current = true;
    try {
      await writeAgentLine(channelId, claudeInput(trimmed));
    } catch (reason) {
      setRunning(false);
      runningRef.current = false;
      setError(String(reason));
    }
  };
  submitRef.current = submitText;

  const stopTurn = async (): Promise<void> => {
    if (!runningRef.current) return;
    if (providerRef.current === "codex") {
      const sessionId = activeSessionRef.current;
      const turnId = activeTurnRef.current;
      if (sessionId && turnId) await codexClient.current?.interrupt(sessionId, turnId);
    } else if (activeChannel.current) {
      await closeAgent(activeChannel.current).catch(() => {});
      activeChannel.current = null;
      setRunning(false);
      runningRef.current = false;
    }
  };

  const selectSession = async (session: MobileSession): Promise<void> => {
    setSessionSheetOpen(false);
    setItems([]);
    setApprovals([]);
    if (providerRef.current === "codex") {
      try {
        await codexClient.current?.resumeSession(session.id);
      } catch (reason) {
        setError(String(reason));
      }
      return;
    }
    const profile = currentProfileRef.current;
    if (profile) await openProvider(profile, "claude", session.id);
  };

  const newSession = async (): Promise<void> => {
    const profile = currentProfileRef.current;
    if (!profile) return;
    setSessionSheetOpen(false);
    if (providerRef.current === "codex") {
      try {
        const id = await codexClient.current?.startSession(profile.cwd || undefined);
        if (id) {
          setActiveSessionId(id);
          activeSessionRef.current = id;
          setItems([]);
        }
      } catch (reason) {
        setError(String(reason));
      }
    } else {
      await openProvider(profile, "claude");
    }
  };

  const changeProvider = async (nextProvider: Provider): Promise<void> => {
    if (nextProvider === providerRef.current) return;
    const profile = currentProfileRef.current;
    if (profile) await openProvider(profile, nextProvider);
  };

  const resolveApproval = async (approval: ApprovalRequest, accepted: boolean): Promise<void> => {
    try {
      await codexClient.current?.resolveApproval(approval.requestId, accepted);
      setApprovals((previous) => previous.filter((item) => item.requestId !== approval.requestId));
    } catch (reason) {
      setError(String(reason));
    }
  };

  const filteredSessions = useMemo(() => {
    const search = sessionSearch.trim().toLowerCase();
    return search
      ? sessions.filter((session) =>
          `${session.title} ${session.cwd ?? ""}`.toLowerCase().includes(search))
      : sessions;
  }, [sessionSearch, sessions]);

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
  const action = composerAction(running, queueMode);

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
          >Codex</button>
          <button
            type="button"
            className={provider === "claude" ? "active" : ""}
            onClick={() => void changeProvider("claude")}
          >Claude</button>
        </div>
      </header>

      <nav className="session-strip" aria-label="Recent sessions">
        <button className="new-session-button" type="button" onClick={() => void newSession()} aria-label="New session">+</button>
        <div className="recent-sessions">
          {sessions.slice(0, 5).map((session) => (
            <button
              type="button"
              key={session.id}
              className={session.id === activeSessionId ? "session-chip active" : "session-chip"}
              onClick={() => void selectSession(session)}
            >
              <span>{session.title}</span>
              {session.updatedAt ? <small>{relativeTime(session.updatedAt)}</small> : null}
            </button>
          ))}
          {sessions.length === 0 ? <span className="session-empty">No saved sessions</span> : null}
        </div>
        <button className="all-sessions-button" type="button" onClick={() => setSessionSheetOpen(true)} aria-label="All sessions">
          <MenuIcon />
        </button>
      </nav>

      <main className="activity-timeline" aria-live="polite">
        <section className="session-heading">
          <div>
            <span className="eyebrow">{provider}</span>
            <h1>{activeSession?.title ?? "New session"}</h1>
          </div>
          <span className={running ? "run-state running" : "run-state"}>
            {running ? "Running" : "Ready"}
          </span>
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
          <button type="button" onClick={() => { setQueue([]); queueRef.current = []; }}>Clear</button>
        </aside>
      ) : null}

      <footer className={action === "steer" ? "mobile-composer steering" : "mobile-composer"}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={action === "steer" ? "Redirect the active task…" : action === "queue" ? "Add the next instruction…" : "Message the agent…"}
          rows={1}
          aria-label="Agent instruction"
        />
        <div className="composer-actions">
          <div className="composer-mode">
            {running ? (
              <button
                type="button"
                className={queueMode ? "" : "active"}
                onClick={() => setQueueMode(false)}
              >Steer</button>
            ) : null}
            {running ? (
              <button
                type="button"
                className={queueMode ? "active" : ""}
                onClick={() => setQueueMode(true)}
              >Queue</button>
            ) : <span>Enter adds a new line</span>}
          </div>
          <div className="composer-buttons">
            {running ? <button type="button" className="stop-button" onClick={() => void stopTurn()}>Stop</button> : null}
            <button
              type="button"
              className="send-button"
              disabled={!draft.trim()}
              onClick={() => void submitText(draft)}
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
            {filteredSessions.map((session) => (
              <button type="button" key={session.id} onClick={() => void selectSession(session)}>
                <span className={session.id === activeSessionId ? "online-dot" : "host-dot"} />
                <span>
                  <strong>{session.title}</strong>
                  <small>{session.cwd || session.id} {relativeTime(session.updatedAt)}</small>
                </span>
              </button>
            ))}
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
  text: string,
  setItems: React.Dispatch<React.SetStateAction<MobileTimelineItem[]>>,
): void => {
  setItems((previous) => [
    ...previous,
    { id: `user-${Date.now()}-${previous.length}`, kind: "user", text },
  ]);
};

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
          <div className="section-heading"><span>SSH connection</span><small>Secrets stay in memory</small></div>
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
