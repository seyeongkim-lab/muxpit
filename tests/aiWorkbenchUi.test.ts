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

test("AI workbench keeps the composer visible while session history loads", () => {
  const styles = readSource("../src/components/AgentWorkbenchPanel.css");

  assert.match(styles, /\.agent-workbench-body \{[^}]*overflow: hidden;/);
  assert.match(styles, /\.agent-conversation \{[^}]*display: grid;/);
  assert.match(styles, /\.agent-conversation \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto auto;/);
  assert.match(styles, /\.agent-composer \{[^}]*grid-row: 4;/);
  assert.match(styles, /\.agent-composer textarea \{[^}]*resize: none;/);
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
  assert.match(openProvider, /client\.resumeSession\(activeSessionId\)/);
  assert.match(openProvider, /client\.loadSession\(activeSessionId/);
});

test("AI workbench invalidates old target channels before restoring the next target", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");
  const targetEffect = workbench.slice(
    workbench.indexOf("if (!open || !leaf || probedTarget === targetKey) return"),
    workbench.indexOf("const persistWorkbench"),
  );

  assert.ok(targetEffect.indexOf("channels.current.clear()") < targetEffect.indexOf("setViews(nextViews)"));
});

test("AI workbench loads Claude history without starting an idle process", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");
  const selectSession = workbench.slice(
    workbench.indexOf("const selectSession"),
    workbench.indexOf("const newSession"),
  );

  assert.match(selectSession, /if \(shouldLoadHistory\) await openClaudeAux\("claude-history", session\.id\)/);
  assert.doesNotMatch(selectSession, /closeChannel\(/);
  assert.match(workbench, /sessionRuntimeLabel\(sessionRuntime\)/);
});

test("AI workbench resumes a disconnected session when it is opened", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");
  const selectSession = workbench.slice(
    workbench.indexOf("const selectSession"),
    workbench.indexOf("const newSession"),
  );

  assert.match(selectSession, /selectedRuntime\.connectionState === "disconnected"/);
  assert.match(selectSession, /await openProvider\(provider, provider === "claude" \? session\.id : undefined\)/);
});

test("AI workbench provider tab lists Claude sessions without starting a process", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");
  const providerEffect = workbench.slice(
    workbench.indexOf("if (!open || probedTarget !== targetKey"),
    workbench.indexOf("useLayoutEffect", workbench.indexOf("if (!open || probedTarget !== targetKey")),
  );

  assert.match(providerEffect, /provider === "claude"/);
  assert.match(providerEffect, /openClaudeAux\(activeSessionId \? "claude-history" : "claude-list", activeSessionId\)/);
  assert.match(providerEffect, /return;[\s\S]*openProvider\(provider\)/);
  assert.match(workbench, /openingProviders\.current\.get\(key\) === opening/);
});

test("AI workbench reopens without resetting a live target", () => {
  const workbench = readSource("../src/components/AgentWorkbenchPanel.tsx");

  assert.match(
    workbench,
    /if \(!open \|\| !leaf \|\| probedTarget === targetKey\) return;/,
  );
  assert.match(
    workbench,
    /\[closeChannel, leaf\?\.id, open, probedTarget, targetKey\]/,
  );
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
