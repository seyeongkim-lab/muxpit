import test from "node:test";
import assert from "node:assert/strict";

import { computeSessionTabWidth, SESSION_TAB_WIDTH_TIERS } from "../src/utils/topBarLayout.ts";

test("computeSessionTabWidth uses the widest tier when there's room", () => {
  assert.equal(computeSessionTabWidth(760, 1), 160);
  assert.equal(computeSessionTabWidth(760, 4), 160);
});

test("computeSessionTabWidth steps down as tab count grows", () => {
  assert.equal(computeSessionTabWidth(760, 5), 128);
  assert.equal(computeSessionTabWidth(760, 6), 96);
  assert.equal(computeSessionTabWidth(760, 9), 72);
});

test("computeSessionTabWidth falls back to the narrowest tier when nothing fits", () => {
  assert.equal(computeSessionTabWidth(760, 50), SESSION_TAB_WIDTH_TIERS.at(-1));
});

test("computeSessionTabWidth handles empty/degenerate input", () => {
  assert.equal(computeSessionTabWidth(0, 3), SESSION_TAB_WIDTH_TIERS[0]);
  assert.equal(computeSessionTabWidth(760, 0), SESSION_TAB_WIDTH_TIERS[0]);
});
