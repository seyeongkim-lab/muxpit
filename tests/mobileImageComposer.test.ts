import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/mobile/MobileApp.tsx", import.meta.url), "utf8");

test("mobile workbench accepts pasted and picked image attachments", () => {
  assert.match(app, /onPaste=\{\(event\) => void addComposerImages/);
  assert.match(app, /<AgentImageAttachments/);
  assert.match(app, /runtime\.attachments\.length/);
  assert.match(app, /Image attachments cannot be queued/);
});
