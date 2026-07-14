import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../src/mobile/mobile.css", import.meta.url), "utf8");

test("mobile workbench grid cannot grow beyond the phone viewport", () => {
  assert.match(styles, /\.mobile-app\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(styles, /\.mobile-app\s*\{[^}]*width:\s*100%/s);
});
