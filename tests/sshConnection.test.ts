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

test("command splitting can be driven by runtime platform", () => {
  assert.equal(
    splitCommandLine(String.raw`ssh -i C:\Users\one\.ssh\id_ed25519 me@host`, {
      platform: "windows",
    })[2],
    String.raw`C:\Users\one\.ssh\id_ed25519`,
  );
  assert.equal(
    splitCommandLine(String.raw`ssh me@host echo\ hello`, {
      platform: "linux",
    })[2],
    "echo hello",
  );
});

test("windows command splitting preserves doubled PowerShell single quotes", () => {
  const parts = splitCommandLine(String.raw`ssh -i 'C:\Users\O''Neil\.ssh\id_ed25519' me@host`, {
    windows: true,
  });
  assert.equal(parts[2], String.raw`C:\Users\O'Neil\.ssh\id_ed25519`);
  assert.equal(parts[3], "me@host");
});

test("SSH parser only accepts the ssh executable name", () => {
  assert.equal(parseSshCommandLine("notssh me@host"), null);
  assert.equal(parseSshCommandLine("sshpass -p secret ssh me@host"), null);
  assert.equal(parseSshCommandLine(String.raw`C:\Windows\System32\OpenSSH\ssh.exe me@host`)?.connection.target, "me@host");
});

test("SSH parser uses injected platform when splitting command lines", () => {
  const parsed = parseSshCommandLine(String.raw`ssh -i C:\Users\one\.ssh\id_ed25519 me@host`, {
    platform: "windows",
  });

  assert.ok(parsed);
  assert.deepEqual(parsed.connection.options, ["-i", String.raw`C:\Users\one\.ssh\id_ed25519`]);
});

test("SSH parser handles value options before host aliases", () => {
  const parsed = parseSshCommandLine("ssh -B en0 -p2222 -Jjump prod-alias uptime");
  assert.ok(parsed);
  assert.deepEqual(parsed.connection.options, ["-B", "en0", "-p", "2222", "-J", "jump"]);
  assert.equal(parsed.connection.target, "prod-alias");
  assert.equal(parsed.remoteCommand, "uptime");
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
