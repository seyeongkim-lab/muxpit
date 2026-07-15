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
