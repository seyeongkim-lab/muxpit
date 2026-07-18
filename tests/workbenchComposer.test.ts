import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8");

test("composer sends on Enter, keeps Shift+Enter for newlines, and guards IME composition", () => {
  const workbench = read("../src/components/AgentWorkbenchPanel.tsx");
  assert.match(workbench, /event\.nativeEvent\.isComposing/);
  assert.match(workbench, /event\.key === "Enter" && !event\.shiftKey/);
  assert.match(workbench, /Enter to send · Shift\+Enter for a new line/);
});

test("Escape stops the running turn from the composer", () => {
  const workbench = read("../src/components/AgentWorkbenchPanel.tsx");
  assert.match(workbench, /event\.key === "Escape" && runtime\.running/);
  assert.match(workbench, /Stop the current task \(Esc\)/);
});

test("timeline rows are memoized and mark the streaming assistant message", () => {
  const workbench = read("../src/components/AgentWorkbenchPanel.tsx");
  const styles = read("../src/components/AgentWorkbenchPanel.css");
  assert.match(workbench, /const TimelineRow = memo\(/);
  assert.match(workbench, /<TimelineRow/);
  assert.match(workbench, /streaming=\{runtime\.running/);
  assert.match(styles, /\.agent-timeline-row\.assistant\.streaming p::after/);
  assert.match(styles, /@keyframes agent-row-in/);
  assert.match(styles, /prefers-reduced-motion/);
});
