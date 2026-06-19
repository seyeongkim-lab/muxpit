import test from "node:test";
import assert from "node:assert/strict";

import {
  decideTerminalInput,
  getTerminalClipboardAction,
  isTerminalCompositionKeyEvent,
  isTerminalTextInputData,
  shouldReadTerminalSelectionForInput,
  shouldClearTerminalInputBuffer,
  shouldScheduleTerminalInputBufferCleanup,
  type TerminalInputState,
} from "../src/utils/terminalInput.ts";

const baseEvent = {
  type: "keydown",
  key: "a",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
};

const baseState: TerminalInputState = {
  prefixActive: false,
  historyOpen: false,
  prefixKeyMatches: false,
  hasSelection: false,
};

test("terminal input policy allows ordinary keys", () => {
  assert.deepEqual(decideTerminalInput(baseEvent, baseState, "linux"), {
    kind: "allowTerminalInput",
  });
});

test("terminal input policy blocks app-level shortcut keys", () => {
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, ctrlKey: true, shiftKey: true }, baseState, "linux"),
    { kind: "blockTerminalInput" },
  );
  assert.deepEqual(decideTerminalInput(baseEvent, { ...baseState, prefixActive: true }, "linux"), {
    kind: "blockTerminalInput",
  });
  assert.deepEqual(decideTerminalInput(baseEvent, { ...baseState, prefixKeyMatches: true }, "linux"), {
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
      }, "linux"),
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

test("terminal input policy maps Linux terminal clipboard shortcuts", () => {
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, key: "c", ctrlKey: true }, { ...baseState, hasSelection: true }, "linux"),
    { kind: "allowTerminalInput" },
  );
  assert.deepEqual(
    decideTerminalInput(
      { ...baseEvent, key: "C", ctrlKey: true, shiftKey: true },
      { ...baseState, hasSelection: true },
      "linux",
    ),
    { kind: "copySelection" },
  );
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, key: "C", ctrlKey: true, shiftKey: true }, baseState, "linux"),
    { kind: "blockTerminalInput" },
  );
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, key: "v", ctrlKey: true }, baseState, "linux"),
    { kind: "allowTerminalInput" },
  );
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, key: "V", ctrlKey: true, shiftKey: true }, baseState, "linux"),
    { kind: "allowNativeClipboard" },
  );
});

test("terminal input policy maps macOS command clipboard shortcuts", () => {
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, key: "c", metaKey: true }, baseState, "macos"),
    { kind: "allowNativeClipboard" },
  );
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, key: "v", metaKey: true }, baseState, "macos"),
    { kind: "allowNativeClipboard" },
  );
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, key: "c", ctrlKey: true }, { ...baseState, hasSelection: true }, "macos"),
    { kind: "allowTerminalInput" },
  );
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, key: "v", ctrlKey: true }, baseState, "macos"),
    { kind: "allowTerminalInput" },
  );
});

test("terminal input policy maps Windows clipboard shortcuts", () => {
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, key: "c", ctrlKey: true }, { ...baseState, hasSelection: true }, "windows"),
    { kind: "copySelection" },
  );
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, key: "c", ctrlKey: true }, baseState, "windows"),
    { kind: "allowTerminalInput" },
  );
  assert.deepEqual(
    decideTerminalInput(
      { ...baseEvent, key: "C", ctrlKey: true, shiftKey: true },
      { ...baseState, hasSelection: true },
      "windows",
    ),
    { kind: "copySelection" },
  );
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, key: "v", ctrlKey: true }, baseState, "windows"),
    { kind: "pasteClipboard" },
  );
  assert.deepEqual(
    decideTerminalInput({ ...baseEvent, key: "V", ctrlKey: true, shiftKey: true }, baseState, "windows"),
    { kind: "allowNativeClipboard" },
  );
});

test("terminal clipboard helpers expose platform actions", () => {
  assert.equal(
    getTerminalClipboardAction(
      { ...baseEvent, key: "C", ctrlKey: true, shiftKey: true },
      { hasSelection: true },
      "linux",
    ),
    "copySelection",
  );
  assert.equal(
    getTerminalClipboardAction({ ...baseEvent, key: "v", metaKey: true }, { hasSelection: false }, "macos"),
    "allowNativeClipboard",
  );
  assert.equal(shouldReadTerminalSelectionForInput({ ...baseEvent, key: "C", ctrlKey: true, shiftKey: true }), true);
  assert.equal(shouldReadTerminalSelectionForInput({ ...baseEvent, key: "v", ctrlKey: true }), false);
});
