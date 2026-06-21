import test from "node:test";
import assert from "node:assert/strict";

import { storedBoolean } from "../src/stores/settings.ts";

test("storedBoolean only accepts persisted true booleans", () => {
  assert.equal(storedBoolean(true), true);
  assert.equal(storedBoolean(false), false);
  assert.equal(storedBoolean("true"), false);
  assert.equal(storedBoolean("false"), false);
  assert.equal(storedBoolean(1), false);
  assert.equal(storedBoolean(null), false);
});
