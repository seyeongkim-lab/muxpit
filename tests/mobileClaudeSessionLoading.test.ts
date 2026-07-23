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
  assert.match(script, /if not user_driven_session\(entries\)/);
  // Filtering has to happen per file while collecting, not after slicing the
  // newest N, or the internal sessions eat most of the returned list.
  const listSessions = script.slice(script.indexOf("def list_sessions"), script.indexOf("def load_session"));
  assert.match(listSessions, /if len\(sessions\) >= MAX_LISTED_SESSIONS:/);
  assert.doesNotMatch(listSessions, /session_files\(root\)\[:MAX_LISTED_SESSIONS\]/);
});

test("session list drops launches that never reached the model", () => {
  // A logged-out CLI answers "Not logged in" from the "<synthetic>" model and
  // exits, leaving a session file per attempt; those are failed starts, not
  // conversations. A session with no assistant reply yet still counts.
  assert.match(script, /def model_answered_session\(entries\):/);
  assert.match(script, /return models != \{"<synthetic>"\}/);
  assert.match(script, /or not model_answered_session\(entries\)/);
});

test("history pairs tool results onto their calls and keeps thinking", () => {
  // Rich timeline rendering needs the structured input, and a result must
  // nest under the call it answers instead of floating as its own row.
  assert.match(script, /call = tool_calls\.get\(block\.get\("tool_use_id"\)\)/);
  assert.match(script, /call\["resultText"\] = tool_text/);
  assert.match(script, /"kind": "thinking"/);
  assert.match(script, /entry\["toolInput"\] = block\.get\("input"\)/);
});

test("session metadata reports the model the transcript actually used", () => {
  // Sessions driven outside muxpit have no synced settings; the newest real
  // assistant reply's model is the only honest label for them.
  assert.match(script, /def session_model\(entries\):/);
  assert.match(script, /value != "<synthetic>"/);
  assert.match(script, /if model:\n\s+metadata\["model"\] = model/);
});

test("session list carries the host CLI defaults for the Default label", () => {
  assert.match(script, /def cli_defaults\(\):/);
  assert.match(script, /data\.get\("effortLevel"\)/);
  assert.match(script, /"defaults": cli_defaults\(\)/);
});

test("session metadata omits an unknown cwd instead of sending an empty base", () => {
  // The file viewer resolves relative paths against the session cwd; an empty
  // string is not nullish in TS, so it would shadow every fallback base.
  assert.match(script, /if cwd:\n\s+metadata\["cwd"\] = cwd/);
  assert.doesNotMatch(script, /"cwd": cwd,/);
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
