import test from "node:test";
import assert from "node:assert/strict";

import {
  hasTauriCurrentWebview,
  hasTauriCurrentWindow,
} from "../src/utils/tauriWindow.ts";

test("tauri window helpers return false without tauri metadata", () => {
  assert.equal(hasTauriCurrentWindow({}), false);
  assert.equal(hasTauriCurrentWebview({}), false);
});

test("tauri window helpers require current labels", () => {
  const host = {
    __TAURI_INTERNALS__: {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
    },
  };

  assert.equal(hasTauriCurrentWindow(host), true);
  assert.equal(hasTauriCurrentWebview(host), true);
});

test("tauri window helpers reject incomplete metadata", () => {
  const host = {
    __TAURI_INTERNALS__: {
      metadata: {
        currentWindow: { label: "main" },
      },
    },
  };

  assert.equal(hasTauriCurrentWindow(host), true);
  assert.equal(hasTauriCurrentWebview(host), false);
});
