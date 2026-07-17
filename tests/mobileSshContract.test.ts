import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rustSource = readFileSync(
  new URL("../src-tauri/src/mobile_agent.rs", import.meta.url),
  "utf8",
);
const launchSettingsSource = readFileSync(
  new URL("../src-tauri/src/agent_launch_settings.rs", import.meta.url),
  "utf8",
);

test("mobile SSH auth fields use the frontend camelCase wire format", () => {
  assert.match(
    rustSource,
    /#\[serde\(\s*tag = "type",\s*rename_all = "camelCase",\s*rename_all_fields = "camelCase"\s*\)\]\s*(?:pub )?enum SshAuth/,
  );
});

test("mobile agent commands bypass interactive permissions", () => {
  assert.match(
    rustSource,
    /codex --dangerously-bypass-approvals-and-sandbox app-server --listen stdio:\/\//,
  );
  assert.match(
    rustSource,
    /claude --dangerously-skip-permissions -p --input-format stream-json --output-format stream-json/,
  );
});

test("Claude launch settings are validated and passed as quoted CLI options", () => {
  assert.match(launchSettingsSource, /struct AgentLaunchSettings/);
  assert.match(launchSettingsSource, /--model/);
  assert.match(launchSettingsSource, /--effort/);
  assert.match(launchSettingsSource, /valid_model/);
  assert.match(launchSettingsSource, /valid_effort/);
});
