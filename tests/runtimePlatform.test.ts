import test from "node:test";
import assert from "node:assert/strict";

import {
  getRuntimePlatform,
  shouldEnableWebglRendererByDefault,
} from "../src/utils/runtimePlatform.ts";

test("runtime platform detects desktop platforms", () => {
  assert.equal(getRuntimePlatform("Win32"), "windows");
  assert.equal(getRuntimePlatform("MacIntel"), "macos");
  assert.equal(getRuntimePlatform("Linux x86_64"), "linux");
  assert.equal(getRuntimePlatform(""), "unknown");
});

test("runtime platform detects Android before generic Linux", () => {
  assert.equal(
    getRuntimePlatform("Linux armv8l", "Mozilla/5.0 (Linux; Android 16; Pixel 9)"),
    "android",
  );
});

test("WebGL renderer default is disabled on Windows and Linux", () => {
  assert.equal(shouldEnableWebglRendererByDefault("Win32"), false);
  assert.equal(shouldEnableWebglRendererByDefault("Linux x86_64"), false);
  assert.equal(shouldEnableWebglRendererByDefault("MacIntel"), true);
  assert.equal(shouldEnableWebglRendererByDefault("FreeBSD amd64"), true);
});
