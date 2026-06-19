import test from "node:test";
import assert from "node:assert/strict";

import {
  decideTerminalInput,
  isTerminalCompositionKeyEvent,
  isTerminalTextInputData,
  shouldClearTerminalInputBuffer,
  shouldScheduleTerminalInputBufferCleanup,
  type TerminalInputState,
} from "../src/utils/terminalInput.ts";

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

test("terminal input policy lets IME composition reach xterm", () => {
  for (const event of [
    { ...baseEvent, isComposing: true, ctrlKey: true, shiftKey: true },
    { ...baseEvent, key: "Process", ctrlKey: true, shiftKey: true },
    { ...baseEvent, keyCode: 229, ctrlKey: true, shiftKey: true },
  ]) {
    assert.equal(isTerminalCompositionKeyEvent(event), true);
    assert.deepEqual(
      decideTerminalInput(event, {
        ...baseState,
        prefixActive: true,
        prefixKeyMatches: true,
      }),
      { kind: "allowTerminalInput" },
    );
  }
});

test("terminal text input data excludes control sequences", () => {
  assert.equal(isTerminalTextInputData("ㅇ"), true);
  assert.equal(isTerminalTextInputData("한"), true);
  assert.equal(isTerminalTextInputData("abc"), true);
  assert.equal(isTerminalTextInputData("\r"), false);
  assert.equal(isTerminalTextInputData("\x1b[A"), false);
  assert.equal(isTerminalTextInputData(""), false);
});

test("terminal input buffer cleanup is scheduled only for stale text input", () => {
  assert.equal(
    shouldScheduleTerminalInputBufferCleanup({
      enabled: true,
      data: "ㅇ",
      textareaValue: "ㅇㅇㅇ",
    }),
    true,
  );
  assert.equal(
    shouldScheduleTerminalInputBufferCleanup({
      enabled: true,
      data: "한",
      textareaValue: "한",
    }),
    true,
  );
  assert.equal(
    shouldScheduleTerminalInputBufferCleanup({
      enabled: false,
      data: "ㅇ",
      textareaValue: "ㅇㅇㅇ",
    }),
    false,
  );
  assert.equal(
    shouldScheduleTerminalInputBufferCleanup({
      enabled: true,
      data: "\r",
      textareaValue: "\r",
    }),
    false,
  );
  assert.equal(
    shouldScheduleTerminalInputBufferCleanup({
      enabled: true,
      data: "ㅇ",
      textareaValue: "",
    }),
    false,
  );
});

test("terminal input buffer cleanup preserves active IME composition", () => {
  assert.equal(
    shouldClearTerminalInputBuffer({
      isComposing: false,
      textareaValue: "ㅇㅇㅇㅇ",
    }),
    true,
  );
  assert.equal(
    shouldClearTerminalInputBuffer({
      isComposing: true,
      textareaValue: "한",
    }),
    false,
  );
  assert.equal(
    shouldClearTerminalInputBuffer({
      isComposing: false,
      textareaValue: "",
    }),
    false,
  );
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
