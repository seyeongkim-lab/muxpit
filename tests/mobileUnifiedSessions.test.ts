import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSessionRuntime, sessionRuntimeKey } from "../src/mobile/agentSessionRuntime.ts";
import { replaceAgentSessions, type MobileSession } from "../src/mobile/agentProtocol.ts";
import {
  buildUnifiedSessionIndex,
  unifiedSessionKey,
} from "../src/mobile/unifiedSessions.ts";
import type { HostProfile } from "../src/mobile/hostProfiles.ts";

const mobileApp = readFileSync(
  new URL("../src/mobile/MobileApp.tsx", import.meta.url),
  "utf8",
);
const bridge = readFileSync(
  new URL("../src/mobile/mobileBridge.ts", import.meta.url),
  "utf8",
);
const nativeAgent = readFileSync(
  new URL("../src-tauri/src/mobile_agent.rs", import.meta.url),
  "utf8",
);
const build = readFileSync(
  new URL("../src-tauri/build.rs", import.meta.url),
  "utf8",
);
const capability = readFileSync(
  new URL("../src-tauri/capabilities/mobile.json", import.meta.url),
  "utf8",
);

const host = (id: string, name: string): HostProfile => ({
  id,
  name,
  host: `${id}.example`,
  port: 22,
  user: "developer",
  cwd: "/repo",
});

test("unified mobile sessions merge hosts and providers by newest update", () => {
  const running = {
    ...createSessionRuntime(),
    connectionState: "connected" as const,
    running: true,
  };
  const entries = buildUnifiedSessionIndex([
    {
      profile: host("alpha", "Alpha"),
      views: {
        codex: {
          sessions: [{ id: "shared", title: "Older task", provider: "codex", updatedAt: 10 }],
          activeSessionId: "shared",
          runtimes: { [sessionRuntimeKey("shared")]: running },
        },
        claude: {
          sessions: [{ id: "claude-1", title: "Newest task", provider: "claude", updatedAt: 30 }],
          activeSessionId: "claude-1",
          runtimes: {},
        },
      },
    },
    {
      profile: host("beta", "Beta"),
      views: {
        codex: {
          sessions: [{ id: "shared", title: "Middle task", provider: "codex", updatedAt: 20 }],
          activeSessionId: "shared",
          runtimes: {},
        },
      },
    },
  ]);

  assert.deepEqual(entries.map((entry) => entry.session.title), [
    "Newest task",
    "Middle task",
    "Older task",
  ]);
  assert.equal(entries[0].profile.name, "Alpha");
  assert.equal(entries[0].provider, "claude");
  assert.equal(entries[2].runtime.running, true);
});

test("unified session keys include host and provider", () => {
  const entries = buildUnifiedSessionIndex([
    {
      profile: host("alpha", "Alpha"),
      views: {
        codex: {
          sessions: [{ id: "shared", title: "Codex", provider: "codex" }],
          activeSessionId: null,
          runtimes: {},
        },
        claude: {
          sessions: [{ id: "shared", title: "Claude", provider: "claude" }],
          activeSessionId: null,
          runtimes: {},
        },
      },
    },
  ]);

  assert.deepEqual(new Set(entries.map(unifiedSessionKey)), new Set([
    "alpha:codex:shared",
    "alpha:claude:shared",
  ]));
});

test("fresh provider sessions replace device-specific cached entries", () => {
  let sessions: MobileSession[] = [
    { id: "shared", title: "Old title", provider: "codex", updatedAt: 10 },
    { id: "stale", title: "Only on this device", provider: "codex", updatedAt: 20 },
  ];
  sessions = replaceAgentSessions([
    { id: "shared", title: "Current title", provider: "codex", updatedAt: 30 },
    { id: "remote", title: "Remote session", provider: "codex", updatedAt: 40 },
  ]);

  assert.deepEqual(sessions.map((session) => session.id), ["remote", "shared"]);
  assert.equal(sessions[1].title, "Current title");
});

test("unified mobile sessions include every desktop provider", () => {
  const profile = host("alpha", "Alpha");
  const providers = ["claude", "codex", "gemini", "copilot", "opencode"] as const;
  const entries = buildUnifiedSessionIndex([{
    profile,
    views: Object.fromEntries(providers.map((provider) => [provider, {
      sessions: [{ id: `${provider}-1`, title: provider, provider }],
      activeSessionId: null,
      runtimes: {},
    }])),
  }]);

  assert.deepEqual(new Set(entries.map((entry) => entry.provider)), new Set(providers));
});

test("mobile refreshes every saved host without replacing active SSH channels", () => {
  assert.match(mobileApp, /const SESSION_REFRESH_INTERVAL_MS = 5_000/);
  assert.match(mobileApp, /const refreshAllProfiles = async/);
  assert.match(mobileApp, /for \(const profile of profilesRef\.current\)/);
  assert.match(mobileApp, /await listInstalledAgents\(profile\.id\)/);
  assert.match(mobileApp, /window\.setInterval\(refresh, SESSION_REFRESH_INTERVAL_MS\)/);
  assert.match(bridge, /listInstalledAgents = \(profileId: string\)[\s\S]*invoke<AgentProvider\[\]>\("mobile_agent_installed"/);
  assert.match(nativeAgent, /sessions: RwLock<HashMap<String, MobileSshSession>>/);
  assert.match(nativeAgent, /profile_id: String/);
  assert.doesNotMatch(nativeAgent, /mobile_ssh_disconnect\(state\.clone\(\)\)\.await/);
  assert.match(build, /"mobile_agent_installed"/);
  assert.match(capability, /"allow-mobile-agent-installed"/);
  assert.match(mobileApp, /sessions: replaceAgentSessions\(event\.sessions\)/);
});

test("mobile opens and controls every desktop ACP provider", () => {
  const openProvider = mobileApp.slice(
    mobileApp.indexOf("const openProvider"),
    mobileApp.indexOf("const connectProfile"),
  );

  assert.match(openProvider, /new AcpClient/);
  assert.match(openProvider, /await client\.initialize\(\)/);
  assert.match(openProvider, /await client\.loadSession\(/);
  assert.match(mobileApp, /await client\.newSession\(/);
  assert.match(mobileApp, /await client\.prompt\(/);
  assert.match(mobileApp, /await client\.cancel\(/);
  assert.match(mobileApp, /automaticPermissionOptionId/);
});

test("selecting a unified session changes host and provider before opening it", () => {
  const connectTarget = mobileApp.slice(
    mobileApp.indexOf("const connectWorkbenchTarget"),
    mobileApp.indexOf("const selectSession"),
  );
  const selectUnified = mobileApp.slice(
    mobileApp.indexOf("const selectUnifiedSession"),
    mobileApp.indexOf("const newSession"),
  );

  assert.match(connectTarget, /credentialForProfile\(profile\.id\)/);
  assert.match(connectTarget, /setProvider\(nextProvider\)/);
  assert.match(connectTarget, /provider:\s*nextProvider/);
  assert.match(connectTarget, /sessionId:\s*blank \? undefined : session\?\.id/);
  assert.match(selectUnified, /connectWorkbenchTarget\(entry\.profile, entry\.provider, entry\.session\)/);
  assert.match(selectUnified, /prepareProvider\(entry\.provider\)/);
  assert.match(selectUnified, /selectSession\(entry\.session\)/);
});

test("new mobile sessions choose a host and provider without global selectors", () => {
  assert.match(mobileApp, /<BottomSheet title="New session"/);
  assert.match(mobileApp, /<span>Host<\/span>/);
  assert.match(mobileApp, /<span>AI<\/span>/);
  assert.match(mobileApp, /createUnifiedSession\(\)/);
  assert.doesNotMatch(mobileApp, /className="provider-switch"/);
});
