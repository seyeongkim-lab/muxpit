import test from "node:test";
import assert from "node:assert/strict";

import { decideTerminalInput, type TerminalInputState } from "../src/utils/terminalInput.ts";

const baseEvent = {
  type: "keydown",
  key: "a",
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
};

const baseState: TerminalInputState = {
  prefixActive: false,
  historyOpen: false,
  prefixKeyMatches: false,
  hasSelection: false,
};

test("terminal input policy allows ordinary keys", () => {
  assert.deepEqual(decideTerminalInput(baseEvent, baseState), {
    kind: "allowTerminalInput",
  });
});

test("terminal input policy blocks app-level shortcut keys", () => {
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, ctrlKey: true, shiftKey: true }, baseState),
    { kind: "blockTerminalInput" },
  );
  assert.deepEqual(decideTerminalInput(baseEvent, { ...baseState, prefixActive: true }), {
    kind: "blockTerminalInput",
  });
  assert.deepEqual(decideTerminalInput(baseEvent, { ...baseState, prefixKeyMatches: true }), {
    kind: "blockTerminalInput",
  });
});

test("terminal input policy maps copy and paste overrides", () => {
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, key: "c", ctrlKey: true }, { ...baseState, hasSelection: true }),
    { kind: "copySelection" },
  );
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, key: "c", ctrlKey: true }, baseState),
    { kind: "allowTerminalInput" },
  );
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, key: "v", ctrlKey: true }, baseState),
    { kind: "pasteClipboard" },
  );
});
