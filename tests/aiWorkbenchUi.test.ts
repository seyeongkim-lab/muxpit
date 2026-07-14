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
