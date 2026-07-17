import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../src/mobile/mobile.css", import.meta.url), "utf8");
const component = readFileSync(
  new URL("../src/mobile/MobileApp.tsx", import.meta.url),
  "utf8",
);

test("mobile workbench grid cannot grow beyond the phone viewport", () => {
  assert.match(styles, /\.mobile-app\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(styles, /\.mobile-app\s*\{[^}]*width:\s*100%/s);
});

test("mobile workbench keeps the host, sessions, and execution context to compact rows", () => {
  assert.match(styles, /\.host-pill\s*\{[^}]*min-height:\s*44px/s);
  assert.match(styles, /\.session-strip\s*\{[^}]*min-height:\s*48px/s);
  assert.match(styles, /\.session-context\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/s);
  assert.match(styles, /\.session-context\s*\{[^}]*min-height:\s*44px/s);
  assert.doesNotMatch(component, /<span className="eyebrow">\{provider\}<\/span>/);
  assert.match(component, /className="execution-summary-value"/);
});
