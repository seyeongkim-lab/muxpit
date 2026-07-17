import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSessionRuntime, sessionRuntimeKey } from "../src/mobile/agentSessionRuntime.ts";
import {
  buildUnifiedSessionIndex,
  unifiedSessionKey,
} from "../src/mobile/unifiedSessions.ts";
import type { HostProfile } from "../src/mobile/hostProfiles.ts";

const mobileApp = readFileSync(
  new URL("../src/mobile/MobileApp.tsx", import.meta.url),
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

  assert.deepEqual(entries.map(unifiedSessionKey), [
    "alpha:codex:shared",
    "alpha:claude:shared",
  ]);
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
