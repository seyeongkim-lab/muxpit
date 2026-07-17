import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSource = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8");

test("AI entry opens a structured workbench beside the terminal", () => {
  const app = readSource("../src/App.tsx");
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");
  const bridge = readSource("../src/agent/desktopAgentBridge.ts");

  assert.match(app, /<AgentWorkbenchPanel/);
  assert.match(app, /agentWorkbenchOpen/);
  assert.doesNotMatch(app, /<AgentLauncherPanel/);
  assert.match(workbench, /openDesktopAgent/);
  assert.match(workbench, /onDesktopAgentTransport/);
  assert.match(bridge, /desktop_agent_open/);
  assert.match(bridge, /desktop-agent-transport/);
  assert.match(workbench, /CodexMobileClient/);
  assert.match(workbench, /AcpClient/);
  assert.match(workbench, /Steer/);
  assert.match(workbench, /Queue/);
});

test("AI workbench uses readable type and a window-relative resize limit", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");
  const styles = readSource("../src/components/AgentWorkbenchPanel.css");

  assert.match(workbench, /window\.innerWidth - MIN_TERMINAL_WIDTH/);
  assert.doesNotMatch(workbench, /Math\.min\(760/);
  assert.doesNotMatch(styles, /max-width: min\(760px/);
  assert.match(styles, /\.agent-workbench \{[\s\S]*?font-size: 13px;/);
  assert.match(styles, /\.agent-timeline-row p \{[\s\S]*?font-size: 14px;/);
  assert.match(styles, /\.agent-composer textarea \{[\s\S]*?font-size: 14px;/);
});

test("desktop workbench folds its close control into the session actions", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");
  const styles = readSource("../src/components/AgentWorkbenchPanel.css");
  const sessionActions = workbench.slice(
    workbench.indexOf('<div className="agent-session-actions">'),
    workbench.indexOf("{newSessionOpen"),
  );

  assert.doesNotMatch(workbench, /className="agent-workbench-header"/);
  assert.match(sessionActions, /aria-label="Close AI workbench"/);
  assert.match(sessionActions, /<svg viewBox="0 0 14 14" aria-hidden="true">/);
  assert.doesNotMatch(styles, /\.agent-workbench-header/);
});

test("Claude helper close cannot leave session loading indefinitely", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");

  assert.match(workbench, /handledPayload/);
  assert.match(workbench, /Claude session history returned no data/);
});

test("AI workbench follows streaming output and approves permission requests", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");

  assert.match(workbench, /latestTimelineTextLength/);
  assert.match(workbench, /runtime\.running/);
  assert.match(workbench, /resolveApproval\(event\.requestId, true\)/);
  assert.match(workbench, /automaticPermissionOptionId\(event\.options\)/);
});

test("desktop workbench exposes mobile execution settings", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");

  assert.match(workbench, /client\.listModels\(\)/);
  assert.match(workbench, /updateSessionSettings\(sessionId, settings\)/);
  assert.match(workbench, /sameClaudeLaunchSettings/);
  assert.match(workbench, />Model</);
  assert.match(workbench, />Effort</);
  assert.match(workbench, />Speed</);
});

test("desktop queue removes an instruction only after it was sent", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");

  assert.match(workbench, /queuedDispatches/);
  assert.match(workbench, /const sent = await submitRef\.current/);
  assert.match(workbench, /if \(sent\) \{/);
});

test("desktop workbench resumes disconnected providers when visible", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");

  assert.match(workbench, /document\.visibilityState === "visible"/);
  assert.match(workbench, /void openProvider\(kind/);
});

test("desktop workbench renders cached sessions while provider probing runs", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");

  assert.match(workbench, /const hasCachedView = view\.sessions\.length > 0/);
  assert.match(workbench, /probing && probedTarget !== targetKey && !hasCachedView/);
});

test("desktop session rail can stop close and restore sessions", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");

  assert.match(workbench, /action: "stop" \| "close" \| "restore"/);
  assert.match(workbench, /closedSessionIds/);
  assert.match(workbench, />Stop</);
  assert.match(workbench, /aria-label={`Close session \${entry\.session\.title}`}/);
  assert.match(workbench, /className="agent-session-control close"/);
  assert.doesNotMatch(workbench, />Close<\/button>/);
  assert.match(workbench, />Restore</);
});

test("desktop session rail uses service icons for Claude and Codex", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");
  const styles = readSource("../src/components/AgentWorkbenchPanel.css");

  assert.match(workbench, /const ProviderMark/);
  assert.match(workbench, /provider-claude\.svg/);
  assert.match(workbench, /provider-codex\.svg/);
  assert.match(workbench, /className={`agent-provider-icon \${provider}`}/);
  assert.match(workbench, /aria-label={PROVIDER_NAMES\[provider\]}/);
  assert.match(styles, /\.agent-session-provider-mark img \{/);
});

test("AI workbench keeps the composer visible while session history loads", () => {
  const styles = readSource("../src/components/AgentWorkbenchPanel.css");

  assert.match(styles, /\.agent-workbench \{[^}]*align-self: stretch;/);
  assert.match(styles, /\.agent-workbench \{[^}]*min-height: 0;/);
  assert.match(styles, /\.agent-workbench-body \{[^}]*overflow: hidden;/);
  assert.match(styles, /\.agent-session-column \{[^}]*min-height: 0;/);
  assert.match(styles, /\.agent-conversation \{[^}]*display: grid;/);
  assert.match(styles, /\.agent-conversation \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto auto;/);
  assert.match(styles, /\.agent-composer \{[^}]*grid-row: 4;/);
  assert.match(styles, /\.agent-composer textarea \{[^}]*resize: none;/);
});

test("desktop workbench uses one host and provider session rail", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");

  assert.match(workbench, /buildDesktopSessionIndex/);
  assert.match(workbench, /contextLabel/);
  assert.match(workbench, /<ProviderMark provider={entry\.provider} \/>/);
  assert.match(workbench, /newSessionContext/);
  assert.match(workbench, /newSessionProvider/);
  assert.doesNotMatch(workbench, /<nav className="agent-provider-tabs"/);
});

test("desktop target runtimes stay mounted across unified session switches", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");

  assert.match(workbench, /targets\.map\(\(target\) => \(/);
  assert.match(workbench, /<DesktopTargetRuntime/);
  assert.match(workbench, /discover=\{open\}/);
  assert.match(workbench, /active=\{open && target\.key === activeTargetKey\}/);
  assert.match(workbench, /onSnapshot=\{updateTargetSnapshot\}/);
});

test("unified desktop rail discovers sessions on every saved host", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");

  assert.match(workbench, /if \(!discover \|\| probedTarget === targetKey\) return;/);
  assert.match(workbench, /for \(const kind of AI_KINDS\)/);
  assert.match(workbench, /openClaudeAux\("claude-list"\)/);
  assert.match(workbench, /openProvider\(kind\)/);
});

test("desktop workbench restores the last host provider and session", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");

  assert.match(workbench, /loadDesktopWorkbenchSelection\(localStorage, AI_KINDS\)/);
  assert.match(workbench, /saveDesktopWorkbenchSelection\(localStorage/);
  assert.match(workbench, /desktopLegacySnapshotKeys\(localStorage, target\.legacyStoragePrefixes\)/);
  assert.match(workbench, /window\.addEventListener\("beforeunload", persistWorkbench\)/);
});

test("fresh provider lists preserve cached desktop sessions", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");

  assert.match(workbench, /const mergeSessions/);
  assert.match(workbench, /sessions: mergeSessions\(current\.sessions, event\.sessions\)/);
});

test("AI workbench stores composer state in each session runtime", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");

  assert.doesNotMatch(workbench, /const \[draft, setDraft\] = useState/);
  assert.doesNotMatch(workbench, /const \[queueMode, setQueueMode\] = useState/);
  assert.match(workbench, /value=\{runtime\.draft\}/);
  assert.match(workbench, /runtime\.queueMode/);
});

test("AI workbench reconnects the cached active session after provider startup", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");
  const openProvider = workbench.slice(
    workbench.indexOf("const openProvider"),
    workbench.indexOf("useEffect(() =>", workbench.indexOf("const openProvider")),
  );

  assert.match(openProvider, /viewsRef\.current\[kind\]\.activeSessionId/);
  assert.match(openProvider, /client\.resumeSession\(resumedSessionId\)/);
  assert.match(openProvider, /client\.loadSession\(resumedSessionId/);
});

test("AI workbench does not close target channels when another target becomes active", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");
  const targetEffect = workbench.slice(
    workbench.indexOf("if (!discover || probedTarget === targetKey) return"),
    workbench.indexOf("const persistWorkbench"),
  );

  assert.match(targetEffect, /probeDesktopAgents\(AI_KINDS, target\)/);
  assert.doesNotMatch(targetEffect, /channels\.current\.clear\(\)/);
  assert.doesNotMatch(targetEffect, /closeChannel\(/);
});

test("AI workbench loads Claude history without starting an idle process", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");
  const selectSession = workbench.slice(
    workbench.indexOf("const selectSession"),
    workbench.indexOf("const newSession"),
  );

  assert.match(selectSession, /if \(shouldLoadHistory\) await openClaudeAux\("claude-history", session\.id\)/);
  assert.doesNotMatch(selectSession, /closeChannel\(/);
  assert.match(workbench, /sessionRuntimeLabel\(entry\.runtime\)/);
});

test("AI workbench resumes a disconnected session when it is opened", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");
  const selectSession = workbench.slice(
    workbench.indexOf("const selectSession"),
    workbench.indexOf("const newSession"),
  );

  assert.match(selectSession, /selectedRuntime\.connectionState === "disconnected"/);
  assert.match(selectSession, /await openProvider\(kind, kind === "claude" \? session\.id : undefined\)/);
});

test("AI workbench active target lists Claude sessions without starting a process", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");
  const providerEffect = workbench.slice(
    workbench.indexOf("if (!active || probedTarget !== targetKey"),
    workbench.indexOf("useLayoutEffect", workbench.indexOf("if (!active || probedTarget !== targetKey")),
  );

  assert.match(providerEffect, /provider === "claude"/);
  assert.match(providerEffect, /openClaudeAux\(activeSessionId \? "claude-history" : "claude-list", activeSessionId\)/);
  assert.match(providerEffect, /return;[\s\S]*openProvider\(provider\)/);
  assert.match(workbench, /openingProviders\.current\.get\(key\) === opening/);
});

test("AI workbench reopens without resetting a live target", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");

  assert.match(workbench, /if \(!active\) return null;/);
  assert.match(workbench, /active=\{open && target\.key === activeTargetKey\}/);
  assert.match(workbench, /for \(const channelId of channels\.current\.keys\(\)\) void closeDesktopAgent\(channelId\)/);
});

test("AI workbench entry points remain visible without unread notifications", () => {
  const sidebar = readSource("../src/components/Sidebar.tsx");
  const topBar = readSource("../src/components/TopDashboardBar.tsx");

  assert.match(sidebar, />\s*AI\s*</);
  assert.match(sidebar, />\s*Inbox\s*/);
  assert.doesNotMatch(sidebar, /totalUnread > 0 && \(\s*<button[^>]*>\s*Inbox/);
  assert.match(topBar, />\s*AI\s*</);
  assert.match(topBar, /Inbox\{totalUnread/);
});

test("onboarding documents hooks and keeps dangerous resume separate", () => {
  const onboarding = readSource("../src/components/OnboardingPanel.tsx");

  assert.match(onboarding, /wmux-cli hooks setup --yes/);
  assert.match(onboarding, /updateCwdRestore/);
  assert.match(onboarding, /updateAgentSessionRestore/);
  assert.match(onboarding, /Approval bypass remains off/);
});
