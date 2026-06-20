import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("settings panel does not call React hooks after the closed-state early return", () => {
  const source = readFileSync(new URL("../src/components/SettingsPanel.tsx", import.meta.url), "utf8");
  const earlyReturnIndex = source.indexOf("if (!open) return null;");
  assert.notEqual(earlyReturnIndex, -1);

  const afterEarlyReturn = source.slice(earlyReturnIndex);
  assert.equal(/\buse(?:Callback|Effect|Memo|Ref|State)\s*\(/.test(afterEarlyReturn), false);
});
