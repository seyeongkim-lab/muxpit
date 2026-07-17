import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/mobile/MobileApp.tsx", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/mobile/mobileBridge.ts", import.meta.url), "utf8");
const rust = readFileSync(new URL("../src-tauri/src/mobile_agent.rs", import.meta.url), "utf8");
const build = readFileSync(new URL("../src-tauri/build.rs", import.meta.url), "utf8");
const capability = readFileSync(new URL("../src-tauri/capabilities/mobile.json", import.meta.url), "utf8");
const cargo = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const hostProfiles = readFileSync(new URL("../src/mobile/hostProfiles.ts", import.meta.url), "utf8");

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

test("background channel interruption keeps the last active task visible until resume", () => {
  const disconnectRuntimes = app.slice(
    app.indexOf("const disconnectProviderRuntimes"),
    app.indexOf("const setProviderError"),
  );
  const closedTransport = app.slice(
    app.indexOf('if (event.kind === "closed")'),
    app.indexOf('if (event.kind !== "stdout"'),
  );

  assert.doesNotMatch(disconnectRuntimes, /running: false/);
  assert.doesNotMatch(disconnectRuntimes, /waiting: false/);
  assert.doesNotMatch(closedTransport, /running: false/);
  assert.match(app, /Connection paused · checking task/);
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

test("foreground resume keeps an idle provider separate from live background channels", () => {
  const resumeConnection = app.slice(
    app.indexOf("const resumeConnection = async"),
    app.indexOf("resumeConnectionRef.current = resumeConnection"),
  );

  assert.match(resumeConnection, /if \(!activeHealth\) \{\s*activeChannel\.current = null;\s*return;/);
  assert.match(resumeConnection, /if \(activeHealth\.alive\) \{\s*activeChannel\.current = activeHealth\.channelId;/);
});

test("failed Codex history resume restores the session input", () => {
  const selectSession = app.slice(
    app.indexOf("const selectSession"),
    app.indexOf("const newSession"),
  );

  assert.match(selectSession, /catch \(reason\) \{\s*updateProviderRuntime\(kind, session\.id, failSessionHistory\);/);
});

test("opening a disconnected mobile session resumes its provider", () => {
  const selectSession = app.slice(
    app.indexOf("const selectSession"),
    app.indexOf("const newSession"),
  );

  assert.match(selectSession, /selectedRuntime\.connectionState === "disconnected"/);
  assert.match(selectSession, /const kind = providerRef\.current/);
  assert.match(selectSession, /await openProvider\(profile, kind, session\.id, true, session\.cwd\)/);
  assert.doesNotMatch(selectSession, /updateRuntime\(/);
});

test("async session operations stay scoped to their starting provider", () => {
  const selectSession = app.slice(
    app.indexOf("const selectSession"),
    app.indexOf("const newSession"),
  );
  const newSession = app.slice(
    app.indexOf("const newSession"),
    app.indexOf("const changeProvider"),
  );
  const applySettings = app.slice(
    app.indexOf("const applyExecutionSettings"),
    app.indexOf("if (connectionStatus", app.indexOf("const applyExecutionSettings")),
  );

  assert.match(selectSession, /updateProviderRuntime\(kind, session\.id/);
  assert.match(newSession, /const kind = providerRef\.current/);
  assert.match(newSession, /moveProviderRuntime\(kind, null, started\.threadId\)/);
  assert.doesNotMatch(newSession, /moveRuntime\(/);
  assert.match(applySettings, /const kind = providerRef\.current/);
  assert.match(applySettings, /updateProviderRuntime\(kind, sessionId/);
  assert.doesNotMatch(applySettings, /updateRuntime\(/);
});

test("shared Codex channel resumes the selected thread", () => {
  const openProvider = app.slice(
    app.indexOf("const openProvider"),
    app.indexOf("const connectProfile"),
  );
  const existingChannel = openProvider.slice(
    openProvider.indexOf("if (existingChannel)"),
    openProvider.indexOf("const existingOpening"),
  );

  assert.match(existingChannel, /await codexClient\.current\?\.resumeSession\(activeProviderSessionId\)/);
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
  assert.match(app, /views: providerViews\.current/);
  assert.match(app, /saveAgentWorkbenchSnapshot\(mobileWorkbenchViewStorageKey\(profileId, kind\)/);
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

test("authenticated SSH credentials use the Android secure store", () => {
  const connectProfile = app.slice(
    app.indexOf("const connectProfile"),
    app.indexOf("const resumeConnection = async"),
  );
  const connectIndex = connectProfile.indexOf("await connectSsh(");
  const trustIndex = connectProfile.indexOf("if (result.trustRequired)");
  const saveIndex = connectProfile.indexOf("await saveSshCredential(profile.id, auth)");

  assert.notEqual(connectIndex, -1);
  assert.notEqual(trustIndex, -1);
  assert.notEqual(saveIndex, -1);
  assert.ok(connectIndex < trustIndex && trustIndex < saveIndex);
  assert.match(bridge, /export const saveSshCredential[\s\S]*invoke\("mobile_credential_save"/);
  assert.match(bridge, /export const loadSshCredential[\s\S]*invoke<SshAuth \| null>\("mobile_credential_load"/);
  assert.match(rust, /android_native_keyring_store::Store/);
  assert.match(rust, /fn initialize_android_credential_context/);
  assert.match(rust, /Java_io_crates_keyring_Keyring_00024Companion_initializeNdkContext/);
  assert.match(rust, /keyring_core::Entry/);
  assert.match(rust, /pub fn mobile_credential_save/);
  assert.match(rust, /pub fn mobile_credential_load/);
  assert.match(cargo, /target_os = "android"[\s\S]*android-native-keyring-store/);
  assert.match(build, /"mobile_credential_save"/);
  assert.match(build, /"mobile_credential_load"/);
  assert.match(capability, /"allow-mobile-credential-save"/);
  assert.match(capability, /"allow-mobile-credential-load"/);
  assert.doesNotMatch(hostProfiles, /password|privateKey|passphrase|SshAuth/);

  const initializeCredential = rust.slice(
    rust.indexOf("async fn initialize_android_credential_context"),
    rust.indexOf("fn credential_entry"),
  );
  assert.match(initializeCredential, /jni_handle\(\)[\s\S]*\.exec/);
  const saveCredential = rust.slice(
    rust.indexOf("pub async fn mobile_credential_save"),
    rust.indexOf("pub async fn mobile_credential_load"),
  );
  const loadCredential = rust.slice(
    rust.indexOf("pub async fn mobile_credential_load"),
    rust.indexOf("#[cfg(not(target_os = \"android\"))]"),
  );
  assert.match(saveCredential, /initialize_android_credential_context\(webview\)\.await[\s\S]*credential_entry/);
  assert.match(loadCredential, /initialize_android_credential_context\(webview\)\.await[\s\S]*credential_entry/);
});

test("saved SSH credentials restore cold starts and host switches", () => {
  const connectFromForm = app.slice(
    app.indexOf("const connectFromForm"),
    app.indexOf("const trustAndConnect"),
  );
  const switchHost = app.slice(
    app.indexOf("const switchHost"),
    app.indexOf("const applyNormalizedEvent"),
  );

  assert.match(app, /const credentialForProfile = async[\s\S]*await loadSshCredential\(profileId\)/);
  assert.match(app, /const restoreInitialProfile = async[\s\S]*await credentialForProfile\(initialProfile.id\)[\s\S]*await connectProfile\(/);
  assert.match(connectFromForm, /authFromForm\(form\) \?\? await credentialForProfile\(profile.id\)/);
  assert.match(switchHost, /await credentialForProfile\(profile.id\)/);
});
