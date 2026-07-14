import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rustSource = readFileSync(
  new URL("../src-tauri/src/mobile_agent.rs", import.meta.url),
  "utf8",
);

test("mobile SSH auth fields use the frontend camelCase wire format", () => {
  assert.match(
    rustSource,
    /#\[serde\(\s*tag = "type",\s*rename_all = "camelCase",\s*rename_all_fields = "camelCase"\s*\)\]\s*enum SshAuth/,
  );
});
