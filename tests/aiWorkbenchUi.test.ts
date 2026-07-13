import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSource = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8");

test("AI launcher uses safe local commands and explicit launch cwd", () => {
  const launcher = readSource("../src/components/AgentLauncherPanel.tsx");
  const commands = readSource("../src/stores/aiCli.ts");

  assert.match(launcher, /LOCAL_AI_COMMAND\[kind\]/);
  assert.match(launcher, /launchCwd: cwd/);
  assert.match(commands, /export const LOCAL_AI_COMMAND/);
  assert.match(commands, /LOCAL_AI_COMMAND[\s\S]*claude: "claude"/);
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
