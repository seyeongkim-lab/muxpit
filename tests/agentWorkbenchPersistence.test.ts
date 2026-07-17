import assert from "node:assert/strict";
import test from "node:test";

import {
  loadAgentWorkbenchSnapshot,
  saveAgentWorkbenchSnapshot,
} from "../src/mobile/agentWorkbenchPersistence.ts";
import {
  createSessionRuntime,
  sessionRuntimeKey,
} from "../src/mobile/agentSessionRuntime.ts";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  },
});

test("workbench snapshot restores content without stale transport state", () => {
  values.clear();
  saveAgentWorkbenchSnapshot("test-workbench", {
    provider: "claude",
    profileId: "host-a",
    views: {
      claude: {
        sessions: [{ id: "session-a", title: "Keep working", provider: "claude" }],
        activeSessionId: "session-a",
        closedSessionIds: ["session-closed"],
        runtimes: {
          [sessionRuntimeKey("session-a")]: {
            ...createSessionRuntime(),
            items: [{ id: "message-a", kind: "assistant", text: "saved output" }],
            approvals: [{ requestId: 4, title: "Old request", detail: "expired" }],
            activeTurnId: "old-turn",
            connectionState: "connected",
            running: true,
            waiting: true,
            queue: ["next instruction"],
            draft: "session draft",
            queueMode: true,
            executionSettings: {
              model: "session-model",
              effort: "high",
              serviceTier: "fast",
            },
            historyState: "loading",
            historyBaseItems: [{ id: "old", kind: "assistant", text: "old" }],
          },
        },
      },
    },
  });

  const restored = loadAgentWorkbenchSnapshot(
    "test-workbench",
    ["codex", "claude"] as const,
  );
  assert.equal(restored?.provider, "claude");
  assert.equal(restored?.profileId, "host-a");
  assert.equal(restored?.views.claude?.activeSessionId, "session-a");
  assert.deepEqual(restored?.views.claude?.closedSessionIds, ["session-closed"]);
  const runtime = restored?.views.claude?.runtimes[sessionRuntimeKey("session-a")];
  assert.deepEqual(runtime?.items, [
    { id: "message-a", kind: "assistant", text: "saved output" },
  ]);
  assert.deepEqual(runtime?.queue, ["next instruction"]);
  assert.equal(runtime?.draft, "session draft");
  assert.equal(runtime?.queueMode, true);
  assert.deepEqual(runtime?.executionSettings, {
    model: "session-model",
    effort: "high",
    serviceTier: "fast",
  });
  assert.equal(runtime?.running, false);
  assert.equal(runtime?.waiting, false);
  assert.equal(runtime?.activeTurnId, null);
  assert.equal(runtime?.connectionState, "disconnected");
  assert.deepEqual(runtime?.approvals, []);
  assert.equal(runtime?.historyState, "idle");
  assert.deepEqual(runtime?.historyBaseItems, []);
  const stored = values.get("test-workbench") ?? "";
  assert.doesNotMatch(stored, /Old request|old-turn|\"historyBaseItems\"/);
});

test("workbench snapshot caps timeline items before writing", () => {
  values.clear();
  saveAgentWorkbenchSnapshot("large-workbench", {
    provider: "codex",
    views: {
      codex: {
        sessions: [],
        activeSessionId: "large",
        runtimes: {
          [sessionRuntimeKey("large")]: {
            ...createSessionRuntime(),
            items: Array.from({ length: 510 }, (_, index) => ({
              id: `item-${index}`,
              kind: "assistant" as const,
              text: String(index),
            })),
          },
        },
      },
    },
  });

  const raw = JSON.parse(values.get("large-workbench") ?? "null") as {
    views: { codex: { runtimes: Record<string, { items: unknown[] }> } };
  };
  assert.equal(raw.views.codex.runtimes[sessionRuntimeKey("large")].items.length, 500);
});

test("workbench snapshot ignores malformed data and unknown providers", () => {
  values.set("bad-json", "{");
  values.set("bad-provider", JSON.stringify({
    version: 1,
    provider: "unknown",
    views: {},
  }));

  assert.equal(loadAgentWorkbenchSnapshot("bad-json", ["codex", "claude"] as const), undefined);
  assert.equal(loadAgentWorkbenchSnapshot("bad-provider", ["codex", "claude"] as const), undefined);
});
