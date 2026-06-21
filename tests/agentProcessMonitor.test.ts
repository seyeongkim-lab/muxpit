import test from "node:test";
import assert from "node:assert/strict";

import { updateAgentProcessMonitorEntry } from "../src/utils/agentProcessMonitor.ts";

test("agent process monitor waits until the process has been seen before clearing", () => {
  const binding = {
    kind: "codex" as const,
    sessionId: "11111111-2222-3333-4444-555555555555",
  };

  const unseen = updateAgentProcessMonitorEntry(undefined, binding, false, 2);
  assert.equal(unseen.shouldClear, false);
  assert.equal(unseen.entry.sawProcess, false);
  assert.equal(unseen.entry.consecutiveMisses, 0);

  const seen = updateAgentProcessMonitorEntry(unseen.entry, binding, true, 2);
  assert.equal(seen.shouldClear, false);
  assert.equal(seen.entry.sawProcess, true);

  const firstMiss = updateAgentProcessMonitorEntry(seen.entry, binding, false, 2);
  assert.equal(firstMiss.shouldClear, false);
  assert.equal(firstMiss.entry.consecutiveMisses, 1);

  const secondMiss = updateAgentProcessMonitorEntry(firstMiss.entry, binding, false, 2);
  assert.equal(secondMiss.shouldClear, true);
  assert.equal(secondMiss.entry.consecutiveMisses, 2);
});

test("agent process monitor resets when the session id changes", () => {
  const previous = {
    kind: "codex" as const,
    sessionId: "11111111-2222-3333-4444-555555555555",
    sawProcess: true,
    consecutiveMisses: 1,
  };

  const next = updateAgentProcessMonitorEntry(
    previous,
    {
      kind: "codex",
      sessionId: "22222222-3333-4444-5555-666666666666",
    },
    false,
    2,
  );

  assert.equal(next.shouldClear, false);
  assert.equal(next.entry.sessionId, "22222222-3333-4444-5555-666666666666");
  assert.equal(next.entry.sawProcess, false);
  assert.equal(next.entry.consecutiveMisses, 0);
});
