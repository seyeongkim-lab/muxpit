import assert from "node:assert/strict";
import test from "node:test";
import { createSessionRuntime, sessionRuntimeKey } from "../src/mobile/agentSessionRuntime.ts";
import {
  buildDesktopSessionIndex,
  desktopSessionKey,
  type DesktopSessionSource,
} from "../src/agent/desktopUnifiedSessions.ts";

const source = (
  contextKey: string,
  contextLabel: string,
  views: DesktopSessionSource["views"],
): DesktopSessionSource => ({ contextKey, contextLabel, views });

test("desktop session index merges hosts and providers by newest update", () => {
  const running = {
    ...createSessionRuntime(),
    connectionState: "connected" as const,
    running: true,
  };
  const entries = buildDesktopSessionIndex([
    source("alpha", "Alpha", {
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
    }),
    source("beta", "Beta", {
      codex: {
        sessions: [{ id: "shared", title: "Middle task", provider: "codex", updatedAt: 20 }],
        activeSessionId: "shared",
        runtimes: {},
      },
    }),
  ]);

  assert.deepEqual(entries.map((entry) => entry.session.title), [
    "Newest task",
    "Middle task",
    "Older task",
  ]);
  assert.equal(entries[0].contextLabel, "Alpha");
  assert.equal(entries[0].provider, "claude");
  assert.equal(entries[2].runtime.running, true);
});

test("desktop session keys include host and provider", () => {
  const entries = buildDesktopSessionIndex([
    source("alpha", "Alpha", {
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
    }),
  ]);

  assert.deepEqual(entries.map(desktopSessionKey), [
    "alpha:codex:shared",
    "alpha:claude:shared",
  ]);
});

test("desktop session index keeps closed sessions restorable", () => {
  const [entry] = buildDesktopSessionIndex([
    source("alpha", "Alpha", {
      codex: {
        sessions: [{ id: "closed", title: "Closed task", provider: "codex" }],
        activeSessionId: null,
        closedSessionIds: ["closed"],
        runtimes: {},
      },
    }),
  ]);

  assert.equal(entry.closed, true);
});
