import test from "node:test";
import assert from "node:assert/strict";

import {
  decideAppShortcut,
  isPlatformClipboardShortcut,
} from "../src/utils/appShortcuts.ts";

const baseEvent = {
  type: "keydown",
  key: "a",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
};

test("app shortcut policy keeps existing Ctrl+Shift app commands", () => {
  assert.deepEqual(
    decideAppShortcut({ ...baseEvent, key: "G", ctrlKey: true, shiftKey: true }, "linux"),
    { kind: "toggleGrid" },
  );
  assert.deepEqual(
    decideAppShortcut({ ...baseEvent, key: "D", ctrlKey: true, shiftKey: true }, "linux"),
    { kind: "splitHorizontal" },
  );
  assert.deepEqual(
    decideAppShortcut({ ...baseEvent, key: "E", ctrlKey: true, shiftKey: true }, "linux"),
    { kind: "splitVertical" },
  );
  assert.deepEqual(
    decideAppShortcut({ ...baseEvent, key: "W", ctrlKey: true, shiftKey: true }, "linux"),
    { kind: "closePane" },
  );
});

test("app shortcut policy reserves platform clipboard shortcuts", () => {
  assert.equal(
    isPlatformClipboardShortcut({ ...baseEvent, key: "C", ctrlKey: true, shiftKey: true }, "linux"),
    true,
  );
  assert.deepEqual(
    decideAppShortcut({ ...baseEvent, key: "C", ctrlKey: true, shiftKey: true }, "linux"),
    { kind: "none" },
  );
  assert.equal(
    isPlatformClipboardShortcut({ ...baseEvent, key: "v", metaKey: true }, "macos"),
    true,
  );
  assert.deepEqual(
    decideAppShortcut({ ...baseEvent, key: "v", metaKey: true }, "macos"),
    { kind: "none" },
  );
  assert.equal(
    isPlatformClipboardShortcut({ ...baseEvent, key: "v", ctrlKey: true }, "windows"),
    true,
  );
});

test("app shortcut policy supports platform primary settings shortcuts", () => {
  assert.deepEqual(
    decideAppShortcut({ ...baseEvent, key: ",", ctrlKey: true }, "linux"),
    { kind: "toggleSettings" },
  );
  assert.deepEqual(
    decideAppShortcut({ ...baseEvent, key: "=", metaKey: true }, "macos"),
    { kind: "increaseFontSize" },
  );
  assert.deepEqual(
    decideAppShortcut({ ...baseEvent, key: "-", metaKey: true }, "macos"),
    { kind: "decreaseFontSize" },
  );
  assert.deepEqual(
    decideAppShortcut({ ...baseEvent, key: "0", metaKey: true }, "macos"),
    { kind: "resetFontSize" },
  );
});

test("app shortcut policy ignores composition and non-keydown events", () => {
  assert.deepEqual(
    decideAppShortcut({ ...baseEvent, key: "G", ctrlKey: true, shiftKey: true, isComposing: true }, "linux"),
    { kind: "none" },
  );
  assert.deepEqual(
    decideAppShortcut({ ...baseEvent, type: "keyup", key: "G", ctrlKey: true, shiftKey: true }, "linux"),
    { kind: "none" },
  );
});
