import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../src/mobile/MobileApp.tsx", import.meta.url),
  "utf8",
);

test("loaded mobile sessions scroll the rendered timeline to the end", () => {
  assert.match(component, /pendingSessionScrollRef\.current = \{ sessionId: event\.session\.id \};/);
  assert.match(component, /timeline\.scrollTop = timeline\.scrollHeight;/);
  assert.match(component, /<main ref=\{timelineRef\} className="activity-timeline"/);
});

test("mobile follows streaming output and approves Codex requests", () => {
  assert.match(component, /latestTimelineTextLength/);
  assert.match(component, /\[activeSessionId, approvals\.length, items\.length, latestTimelineTextLength, running\]/);
  assert.match(component, /resolveApproval\(event\.requestId, true\)/);
});

test("mobile exposes background activity and per-session execution settings", () => {
  assert.match(component, /unifiedSessions/);
  assert.match(component, /session-chip-meta/);
  assert.match(component, /session-state-dot/);
  assert.match(component, /setSettingsSheetOpen\(true\)/);
  assert.match(component, /Model/);
  assert.match(component, /Effort/);
  assert.match(component, /Speed/);
  assert.match(component, /threadSettings/);
});

test("queued instructions are removed only after a successful send", () => {
  const completion = component.slice(
    component.indexOf('case "turnCompleted"'),
    component.indexOf('case "messageDelta"'),
  );

  assert.doesNotMatch(completion, /queue: runtime\.queue\.slice\(1\)/);
  assert.match(completion, /if \(sent\)[\s\S]*queue: runtime\.queue\[0\] === next \? runtime\.queue\.slice\(1\)/);
});

test("Claude setting changes do not close a running channel", () => {
  const applySettings = component.slice(
    component.indexOf("const applyExecutionSettings"),
    component.indexOf("if (connectionStatus", component.indexOf("const applyExecutionSettings")),
  );

  assert.doesNotMatch(applySettings, /closeAgent\(/);
  assert.doesNotMatch(applySettings, /openProvider\(/);
});

test("failed Codex steer keeps the active turn running", () => {
  const submit = component.slice(
    component.indexOf("const submitText"),
    component.indexOf("submitRef.current =", component.indexOf("const submitText")),
  );

  assert.match(submit, /if \(action !== "steer"\)[\s\S]*running: false/);
});
