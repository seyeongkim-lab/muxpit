import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(
  new URL("../src/mobile/MobileApp.tsx", import.meta.url),
  "utf8",
);
const stylesheet = readFileSync(
  new URL("../src/mobile/mobile.css", import.meta.url),
  "utf8",
);

test("mobile SSH fields scroll independently from the connection action", () => {
  assert.match(
    component,
    /<main className="connect-screen">\s*<div className="connect-scroll">/,
  );
  assert.match(component, /<footer className="connect-footer">/);
  assert.match(
    stylesheet,
    /\.connect-screen\s*{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto;/s,
  );
  assert.match(
    stylesheet,
    /\.connect-scroll\s*{[^}]*overflow-y:\s*auto;/s,
  );
});
