import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSource = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8");

test("desktop agent bridge exposes structured local and SSH channels", () => {
  const backend = readSource("../src-tauri/src/desktop_agent.rs");
  const desktop = readSource("../src-tauri/src/desktop_impl.rs");
  const bridge = readSource("../src/agent/desktopAgentBridge.ts");

  assert.match(backend, /DesktopAgentManager/);
  assert.match(backend, /codex app-server --listen stdio:\/\//);
  assert.match(backend, /claude -p --input-format stream-json --output-format stream-json/);
  assert.match(backend, /copilot --acp --stdio/);
  assert.match(backend, /opencode acp/);
  assert.match(backend, /gemini --experimental-acp/);
  assert.match(desktop, /desktop_agent_open/);
  assert.match(desktop, /check_local_clis/);
  assert.match(bridge, /desktop_agent_write/);
  assert.match(bridge, /desktop_agent_close/);
});
