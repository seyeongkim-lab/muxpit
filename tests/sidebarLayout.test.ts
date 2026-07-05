import test from "node:test";
import assert from "node:assert/strict";

import { clampFilesRailWidth } from "../src/stores/sidebarLayout.ts";

test("clampFilesRailWidth keeps the rail within min/max and rounds", () => {
  assert.equal(clampFilesRailWidth(100), 180);
  assert.equal(clampFilesRailWidth(9000), 640);
  assert.equal(clampFilesRailWidth(272), 272);
  assert.equal(clampFilesRailWidth(300.6), 301);
});
