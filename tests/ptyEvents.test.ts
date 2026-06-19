import test from "node:test";
import assert from "node:assert/strict";

import { consumePtyEventsForId, describePtyExit } from "../src/utils/ptyEvents.ts";

test("pty event drain consumes the reconnect buffer and returns only the new pty", () => {
  const events = [
    { id: 1, data: "old" },
    { id: 2, data: "new" },
  ];

  assert.deepEqual(consumePtyEventsForId(events, 2), [{ id: 2, data: "new" }]);
  assert.deepEqual(events, []);
});

test("pty exit message includes an exit code when available", () => {
  assert.equal(describePtyExit(127), "reconnected PTY exited immediately with code 127");
  assert.equal(describePtyExit(null), "reconnected PTY exited immediately");
});
