import assert from "node:assert/strict";
import test from "node:test";
import { browserWebviewLabel, normalizeBrowserUrl } from "../src/utils/browserWebview.ts";

test("browser surface labels are stable and contain only Tauri label characters", () => {
  assert.equal(browserWebviewLabel("pane 1/@host"), "wmux-browser-pane-1-host");
});

test("browser URLs accept HTTP and HTTPS only", () => {
  assert.equal(normalizeBrowserUrl("example.com"), "https://example.com/");
  assert.equal(normalizeBrowserUrl("http://localhost:5173/path"), "http://localhost:5173/path");
  assert.throws(() => normalizeBrowserUrl("file:///tmp/secret"));
  assert.throws(() => normalizeBrowserUrl("javascript:alert(1)"));
});
