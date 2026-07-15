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
  assert.match(resetAgentState, /setRuntimes\(\(current\) =>/);
  assert.match(resetAgentState, /runtimesRef\.current = next/);
  assert.match(connectProfile, /const reconnecting = restore !== undefined/);
  assert.match(connectProfile, /if \(!reconnecting\) \{[\s\S]*setConnectionStatus\("connecting"\)/);
  assert.match(connectProfile, /await openProvider\([\s\S]*reconnecting/);
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
