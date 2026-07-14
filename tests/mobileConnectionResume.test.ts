import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/mobile/MobileApp.tsx", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/mobile/mobileBridge.ts", import.meta.url), "utf8");
const rust = readFileSync(new URL("../src-tauri/src/mobile_agent.rs", import.meta.url), "utf8");

test("mobile app checks and restores SSH when returning to the foreground", () => {
  assert.match(app, /document\.addEventListener\("visibilitychange"/);
  assert.match(app, /await probeSsh\(\)/);
  assert.match(app, /openProvider\(profile, currentProvider, sessionId, true\)/);
  assert.match(app, /event\.kind === "exit"[^}]*activeChannel\.current === event\.channelId/s);
  assert.match(bridge, /export const probeSsh/);
  assert.match(rust, /pub async fn mobile_ssh_probe/);
});
