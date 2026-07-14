import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/components/TopDashboardBar.tsx", import.meta.url),
  "utf8",
);

test("dashboard popover stays anchored below its tabs", () => {
  const dashboardTabs = source.indexOf('<div style={styles.dashboardTabs}>');
  const popover = source.indexOf("style={styles.popover}");
  const filesButton = source.indexOf("onClick={onToggleFilesRail}");

  assert.ok(dashboardTabs >= 0);
  assert.ok(popover > dashboardTabs && popover < filesButton);
  assert.match(source, /dashboardTabs:\s*\{[\s\S]*?position: "relative"/);
  assert.match(source, /popover:\s*\{[\s\S]*?top: 36,[\s\S]*?left: 0,/);
  assert.doesNotMatch(source, /popover:\s*\{[\s\S]*?right: 138,/);
});
