import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pickWorkbenchFocusLeaf } from "../src/utils/workbenchFocus.ts";

const leaves = [
  { workspaceId: "w1", leafId: "l1", contextKey: "local", cwd: "/home/me/proj-a", focused: false },
  { workspaceId: "w2", leafId: "l2", contextKey: "local", cwd: "/home/me/proj-b", focused: true },
  { workspaceId: "w3", leafId: "l3", contextKey: "ssh:ssh:dev:", cwd: "/srv/app", focused: false },
];

test("selecting a session focuses the pane whose cwd matches", () => {
  const leaf = pickWorkbenchFocusLeaf(leaves, "local", "/home/me/proj-a");
  assert.equal(leaf?.leafId, "l1");
});

test("cwd match ignores trailing slashes", () => {
  const leaf = pickWorkbenchFocusLeaf(leaves, "local", "/home/me/proj-a/");
  assert.equal(leaf?.leafId, "l1");
});

test("falls back to the focused pane on the host when no cwd matches", () => {
  const leaf = pickWorkbenchFocusLeaf(leaves, "local", "/somewhere/else");
  assert.equal(leaf?.leafId, "l2");
});

test("falls back to any pane on the host without a session cwd", () => {
  const leaf = pickWorkbenchFocusLeaf(leaves, "ssh:ssh:dev:");
  assert.equal(leaf?.leafId, "l3");
});

test("returns null when the host has no open pane", () => {
  assert.equal(pickWorkbenchFocusLeaf(leaves, "ssh:ssh:other:"), null);
});

test("prefers the focused pane among multiple cwd matches", () => {
  const dupes = [
    { workspaceId: "w1", leafId: "a", contextKey: "local", cwd: "/p", focused: false },
    { workspaceId: "w2", leafId: "b", contextKey: "local", cwd: "/p", focused: true },
  ];
  assert.equal(pickWorkbenchFocusLeaf(dupes, "local", "/p")?.leafId, "b");
});

test("workbench wires session selection and smooth scrolling", () => {
  const workbench = readFileSync(
    new URL("../src/components/AgentWorkbenchPanel.tsx", import.meta.url),
    "utf8",
  );
  // Session selection carries the session cwd into terminal focus.
  assert.match(workbench, /requestSelection\(entry\.contextKey, entry\.provider, entry\.session\.id, false, entry\.session\.cwd\)/);
  assert.match(workbench, /pickWorkbenchFocusLeaf/);
  // Timeline only auto-scrolls while pinned to the bottom.
  assert.match(workbench, /onScroll=\{handleTimelineScroll\}/);
  assert.match(workbench, /timelinePinned/);
  // History loading is distinguished from an empty session.
  assert.match(workbench, /Loading session history/);
});
