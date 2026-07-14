import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../src/mobile/MobileApp.tsx", import.meta.url),
  "utf8",
);

test("loaded mobile sessions scroll the rendered timeline to the end", () => {
  assert.match(component, /pendingSessionScrollRef\.current = \{\s*sessionId: event\.session\.id,\s*items: event\.items,\s*\};/);
  assert.match(component, /timeline\.scrollTop = timeline\.scrollHeight;/);
  assert.match(component, /<main ref=\{timelineRef\} className="activity-timeline"/);
});
