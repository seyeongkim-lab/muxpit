import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/mobile/MobileApp.tsx", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/mobile/mobileBridge.ts", import.meta.url), "utf8");
const rust = readFileSync(new URL("../src-tauri/src/mobile_agent.rs", import.meta.url), "utf8");
const script = readFileSync(new URL("../src-tauri/scripts/claude_sessions.py", import.meta.url), "utf8");

test("session list only offers UUID-named files claude can resume", () => {
  // agent-*.jsonl subagent transcripts live in the same projects tree but
  // `claude --resume` rejects their ids, so listing them yields dead sessions.
  assert.match(script, /def resumable_session_file\(path\):/);
  assert.match(script, /if not resumable_session_file\(path\):/);
  assert.match(script, /SESSION_ID_RE = re\.compile\(/);
});

test("session list keeps only sessions a person actually drove", () => {
  // claude's own conversation-summarizer sessions are resumable but were never
  // driven by a person, and they outnumber real conversations; only a prompt
  // submitted through the normal input path records "last-prompt".
  assert.match(script, /def user_driven_session\(entries\):/);
  assert.match(script, /item\.get\("type"\) == "last-prompt"/);
  assert.match(script, /if not user_driven_session\(entries\):/);
  // Filtering has to happen per file while collecting, not after slicing the
  // newest N, or the internal sessions eat most of the returned list.
  const listSessions = script.slice(script.indexOf("def list_sessions"), script.indexOf("def load_session"));
  assert.match(listSessions, /if len\(sessions\) >= MAX_LISTED_SESSIONS:/);
  assert.doesNotMatch(listSessions, /session_files\(root\)\[:MAX_LISTED_SESSIONS\]/);
});

test("Claude session selection loads history without rescanning the full list", () => {
  assert.match(script, /for updated_at, path in session_files\(root\)\[:MAX_SCANNED_SESSIONS\]:/);
  assert.match(script, /"type": "muxpit_claude_session"/);
  assert.match(bridge, /export const loadClaudeSession/);
  assert.match(app, /loadClaudeSession\(profile\.id, channelId, sessionId\)/);
  assert.match(app, /if \(shouldLoadHistory\) await requestClaudeData\(session\.id\)/);
  assert.doesNotMatch(app, /openProvider\(profile, "claude", session\.id, true, session\.cwd\)/);
  const loadSession = script.slice(script.indexOf("def load_session"), script.indexOf("def main"));
  assert.match(loadSession, /glob\.escape\(session_id\)/);
  assert.doesNotMatch(loadSession, /session_files\(root\)/);
  assert.match(rust, /const CLAUDE_SESSION_SCRIPT: &str = include_str!/);
});

test("Claude provider browsing uses helpers and keeps provider channels alive", () => {
  const changeProvider = app.slice(
    app.indexOf("const changeProvider"),
    app.indexOf("const resolveApproval"),
  );
  const prepareProvider = app.slice(
    app.indexOf("const prepareProvider"),
    app.indexOf("const openProvider"),
  );

  assert.match(changeProvider, /prepareProvider\(nextProvider\)/);
  assert.match(changeProvider, /const shouldRequestClaudeData = sessionId/);
  assert.match(changeProvider, /if \(shouldRequestClaudeData\) await requestClaudeData\(sessionId\)/);
  assert.doesNotMatch(changeProvider, /openProvider\(profile, "claude"\)/);
  assert.doesNotMatch(prepareProvider, /closeAgent\(|resetAgentState\(/);
  assert.match(prepareProvider, /providerViews\.current\[nextProvider\]/);
  assert.match(app, /normalizedHandlerRef\.current\("codex", event\)/);
  assert.match(app, /normalizedHandlerRef\.current\(meta\.provider, normalized\)/);
  assert.match(app, /openingProviders\.current\.get\(key\) === opening/);
});
