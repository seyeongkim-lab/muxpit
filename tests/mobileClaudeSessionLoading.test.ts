import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/mobile/MobileApp.tsx", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/mobile/mobileBridge.ts", import.meta.url), "utf8");
const rust = readFileSync(new URL("../src-tauri/src/mobile_agent.rs", import.meta.url), "utf8");
const script = readFileSync(new URL("../src-tauri/scripts/claude_sessions.py", import.meta.url), "utf8");

test("Claude session selection loads history without rescanning the full list", () => {
  assert.match(script, /for updated_at, path in session_files\(root\)\[:100\]:/);
  assert.match(script, /"type": "wmux_claude_session"/);
  assert.match(bridge, /export const loadClaudeSession/);
  assert.match(app, /loadClaudeSession\(historyChannel, sessionId\)/);
  assert.match(rust, /const CLAUDE_SESSION_SCRIPT: &str = include_str!/);
});
