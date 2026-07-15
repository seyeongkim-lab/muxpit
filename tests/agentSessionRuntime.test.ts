import test from "node:test";
import assert from "node:assert/strict";

import {
  beginSessionHistory,
  completeSessionHistory,
  failSessionHistory,
  moveSessionRuntime,
  readSessionRuntime,
  updateSessionRuntime,
} from "../src/mobile/agentSessionRuntime.ts";

test("session runtime keeps background turns isolated", () => {
  let runtimes = {};
  runtimes = updateSessionRuntime(runtimes, "session-a", (runtime) => ({
    ...runtime,
    activeTurnId: "turn-a",
    running: true,
  }));
  runtimes = updateSessionRuntime(runtimes, "session-b", (runtime) => ({
    ...runtime,
    items: [{ id: "message-b", kind: "assistant", text: "B output" }],
  }));

  assert.equal(readSessionRuntime(runtimes, "session-a").running, true);
  assert.equal(readSessionRuntime(runtimes, "session-a").waiting, false);
  assert.equal(readSessionRuntime(runtimes, "session-a").activeTurnId, "turn-a");
  assert.equal(readSessionRuntime(runtimes, "session-b").running, false);
  assert.deepEqual(readSessionRuntime(runtimes, "session-b").items, [
    { id: "message-b", kind: "assistant", text: "B output" },
  ]);
});

test("new session runtime moves to the provider session id", () => {
  let runtimes = updateSessionRuntime({}, null, (runtime) => ({
    ...runtime,
    running: true,
    items: [{ id: "draft", kind: "user", text: "Start" }],
  }));

  runtimes = moveSessionRuntime(runtimes, null, "session-new");

  assert.equal(readSessionRuntime(runtimes, "session-new").running, true);
  assert.deepEqual(readSessionRuntime(runtimes, "session-new").items, [
    { id: "draft", kind: "user", text: "Start" },
  ]);
  assert.deepEqual(readSessionRuntime(runtimes, null).items, []);
});

test("session history preserves events received while loading", () => {
  let runtime = beginSessionHistory({
    ...readSessionRuntime({}, "session-a"),
    historyState: "loaded",
    items: [{ id: "cached", kind: "assistant", text: "cached output" }],
  }, "session-a");
  runtime = {
    ...runtime,
    items: [
      { id: "cached", kind: "assistant", text: "streamed output" },
      { id: "live", kind: "assistant", text: "new output" },
    ],
  };

  runtime = completeSessionHistory(runtime, [
    { id: "old", kind: "user", text: "old input" },
    { id: "cached", kind: "assistant", text: "canonical output" },
    { id: "live", kind: "assistant", text: "old output" },
  ]);

  assert.equal(runtime.historyState, "loaded");
  assert.deepEqual(runtime.items, [
    { id: "old", kind: "user", text: "old input" },
    { id: "cached", kind: "assistant", text: "streamed output" },
    { id: "live", kind: "assistant", text: "new output" },
  ]);
});

test("failed session history can be retried", () => {
  const loading = beginSessionHistory(readSessionRuntime({}, "session-a"), "session-a");
  const failed = failSessionHistory(loading);

  assert.equal(failed.historyState, "idle");
  assert.deepEqual(failed.items, []);
});
