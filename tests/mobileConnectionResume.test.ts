import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/mobile/MobileApp.tsx", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/mobile/mobileBridge.ts", import.meta.url), "utf8");
const rust = readFileSync(new URL("../src-tauri/src/mobile_agent.rs", import.meta.url), "utf8");
const build = readFileSync(new URL("../src-tauri/build.rs", import.meta.url), "utf8");
const capability = readFileSync(new URL("../src-tauri/capabilities/mobile.json", import.meta.url), "utf8");

test("mobile app checks and restores SSH when returning to the foreground", () => {
  assert.match(app, /document\.addEventListener\("visibilitychange"/);
  assert.match(app, /await probeSsh\(\)/);
  assert.match(app, /openProvider\(profile, currentProvider, sessionId, true, sessionCwd\)/);
  assert.match(app, /event\.kind === "stderr"[^}]*activeChannel\.current === event\.channelId/s);
  assert.match(app, /event\.kind === "exit"[^}]*activeChannel\.current === event\.channelId/s);
  assert.match(bridge, /export const probeSsh/);
  assert.match(bridge, /export const probeAgent/);
  assert.match(rust, /pub async fn mobile_ssh_probe/);
  assert.match(rust, /pub async fn mobile_agent_probe/);
  assert.match(build, /"mobile_agent_probe"/);
  assert.match(capability, /"allow-mobile-agent-probe"/);
});

test("foreground reconnect keeps the current workbench until the provider resumes", () => {
  const resetAgentState = app.slice(
    app.indexOf("const resetAgentState"),
    app.indexOf("const openProvider"),
  );
  const connectProfile = app.slice(
    app.indexOf("const connectProfile"),
    app.indexOf("const resumeConnection = async"),
  );

  assert.match(resetAgentState, /const next = preserveView[\s\S]*: \{\};/);
  assert.match(resetAgentState, /Object\.entries\(runtimesRef\.current\)/);
  assert.doesNotMatch(resetAgentState, /setRuntimes\(\(current\) =>/);
  assert.match(resetAgentState, /setRuntimes\(next\)/);
  assert.match(resetAgentState, /runtimesRef\.current = next/);
  assert.match(connectProfile, /const preservingView = restore !== undefined/);
  assert.match(connectProfile, /const reconnecting = preservingView[\s\S]*connectionStatusRef\.current === "connected"[\s\S]*currentProfileRef\.current\?\.id === profile\.id/);
  assert.match(connectProfile, /if \(!reconnecting\) \{[\s\S]*setConnectionStatus\("connecting"\)/);
  assert.match(connectProfile, /await openProvider\([\s\S]*preservingView/);
  assert.doesNotMatch(connectProfile, /void openProvider\(/);
});

test("foreground resume verifies native provider channels", () => {
  const resumeConnection = app.slice(
    app.indexOf("const resumeConnection = async"),
    app.indexOf("resumeConnectionRef.current = resumeConnection"),
  );
  const sshProbe = resumeConnection.indexOf("await probeSsh()");
  const agentProbe = resumeConnection.indexOf("await probeAgent(channelId)");

  assert.notEqual(sshProbe, -1);
  assert.notEqual(agentProbe, -1);
  assert.ok(sshProbe < agentProbe);
  assert.doesNotMatch(resumeConnection, /if \(activeChannel\.current\) return;/);
});

test("failed Codex history resume restores the session input", () => {
  const selectSession = app.slice(
    app.indexOf("const selectSession"),
    app.indexOf("const newSession"),
  );

  assert.match(selectSession, /catch \(reason\) \{\s*updateRuntime\(session\.id, failSessionHistory\);/);
});

test("mobile workbench persists the selected session without credentials", () => {
  assert.match(app, /loadAgentWorkbenchSnapshot/);
  assert.match(app, /saveAgentWorkbenchSnapshot/);
  assert.match(app, /const profileId = currentProfileRef\.current\?\.id \?\? restoredProfileId\.current/);
  assert.match(app, /profileId,/);
  assert.match(app, /value=\{runtime\.draft\}/);
  assert.doesNotMatch(app, /const \[draft, setDraft\] = useState/);
});

test("mobile workbench scopes cached views by host and provider", () => {
  assert.match(app, /mobileWorkbenchViewStorageKey/);
  assert.match(app, /saveAgentWorkbenchSnapshot\(mobileWorkbenchViewStorageKey\(profileId, currentProvider\)/);
  assert.match(app, /loadCachedWorkbenchView/);
  assert.match(app, /persistWorkbenchRef\.current\(\);[\s\S]*loadCachedWorkbenchView\(profileId, nextProvider\)/);
});

test("connecting another host clears or restores only that host view", () => {
  const connectFromForm = app.slice(
    app.indexOf("const connectFromForm"),
    app.indexOf("const trustAndConnect"),
  );
  const switchHost = app.slice(
    app.indexOf("const switchHost"),
    app.indexOf("const applyNormalizedEvent"),
  );

  assert.match(connectFromForm, /loadCachedWorkbenchView\(profile\.id, providerRef\.current\)/);
  assert.match(switchHost, /loadCachedWorkbenchView\(profile\.id, providerRef\.current\)/);
});

test("switching to a host without cached credentials preserves the previous host cache", () => {
  const switchHost = app.slice(
    app.indexOf("const switchHost"),
    app.indexOf("const applyNormalizedEvent"),
  );
  const missingCredentialBranch = switchHost.slice(
    switchHost.indexOf("if (!auth)"),
    switchHost.indexOf("await connectProfile"),
  );

  assert.match(missingCredentialBranch, /replaceWorkbenchView\(cachedView\)/);
  assert.match(missingCredentialBranch, /restoredProfileId\.current = profile\.id/);
});

test("cold Claude reconnect refreshes cached history", () => {
  const openProvider = app.slice(
    app.indexOf("const openProvider"),
    app.indexOf("const connectProfile"),
  );

  assert.match(openProvider, /const shouldRequestClaudeData = nextProvider === "claude"[\s\S]*preserveView/);
  assert.match(openProvider, /preserveView[\s\S]*beginSessionHistory/);
});
