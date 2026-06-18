import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSshCommandWithRemoteCmdFromBase,
  parseSshCommandLine,
  splitCommandLine,
  sshConnectionToArgv,
} from "../src/utils/sshConnection.ts";
import { isPowerShellCommand } from "../src/utils/runtimePlatform.ts";

test("windows command splitting preserves UNC identity paths", () => {
  const parts = splitCommandLine(String.raw`ssh -i \\server\share\id_ed25519 me@host`, {
    windows: true,
  });
  assert.equal(parts[2], String.raw`\\server\share\id_ed25519`);
});

test("SSH parser preserves explicit terminal mode for primary spawn", () => {
  const parsed = parseSshCommandLine("ssh -T prod-alias uptime");
  assert.ok(parsed);
  assert.equal(parsed.connection.target, "prod-alias");
  assert.equal(parsed.connection.ttyMode, "disable");
  assert.deepEqual(
    sshConnectionToArgv(parsed.connection, {
      preserveTtyMode: true,
      remoteCommand: parsed.remoteCommand,
    }),
    ["ssh", "-T", "prod-alias", "uptime"],
  );
});

test("remote command fallback appends to the original wrapper command", () => {
  assert.equal(
    buildSshCommandWithRemoteCmdFromBase(
      "sshpass -p secret ssh me@host",
      "bash -lc 'claude'",
      true,
    ),
    "sshpass -p secret ssh me@host 'bash -lc '\\''claude'\\'''",
  );
});

test("bare cmd is treated as a Windows shell command", () => {
  assert.equal(isPowerShellCommand("cmd"), true);
  assert.equal(isPowerShellCommand("cmd.exe"), true);
});
