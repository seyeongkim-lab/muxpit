import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  cliExecutableNameForTarget,
  cliOutputPathForTarget,
  hostTripleFromPlatform,
  resolveCliTargets,
  sidecarNameForTarget,
  sidecarOutputPathForTarget,
  targetsFromArgs,
} from "../scripts/build-cli-sidecars.mjs";

test("hostTripleFromPlatform maps desktop platforms to Rust target triples", () => {
  assert.equal(hostTripleFromPlatform("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(hostTripleFromPlatform("linux", "arm64"), "aarch64-unknown-linux-gnu");
  assert.equal(hostTripleFromPlatform("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.equal(hostTripleFromPlatform("win32", "arm64"), "aarch64-pc-windows-msvc");
  assert.equal(hostTripleFromPlatform("darwin", "x64"), "x86_64-apple-darwin");
  assert.equal(hostTripleFromPlatform("darwin", "arm64"), "aarch64-apple-darwin");
});

test("sidecarNameForTarget follows Tauri externalBin naming rules", () => {
  assert.equal(sidecarNameForTarget("x86_64-unknown-linux-gnu"), "muxpit-cli-x86_64-unknown-linux-gnu");
  assert.equal(sidecarNameForTarget("x86_64-pc-windows-msvc"), "muxpit-cli-x86_64-pc-windows-msvc.exe");
  assert.equal(sidecarNameForTarget("aarch64-apple-darwin"), "muxpit-cli-aarch64-apple-darwin");
  assert.equal(sidecarNameForTarget("universal-apple-darwin"), "muxpit-cli-universal-apple-darwin");
});

test("cliExecutableNameForTarget adds exe extension only for Windows", () => {
  assert.equal(cliExecutableNameForTarget("x86_64-pc-windows-msvc"), "muxpit-cli.exe");
  assert.equal(cliExecutableNameForTarget("x86_64-unknown-linux-gnu"), "muxpit-cli");
  assert.equal(cliExecutableNameForTarget("aarch64-apple-darwin"), "muxpit-cli");
});

test("targetsFromArgs accepts target flags and comma-separated targets", () => {
  assert.deepEqual(targetsFromArgs(["--target", "x86_64-pc-windows-msvc"]), [
    "x86_64-pc-windows-msvc",
  ]);
  assert.deepEqual(targetsFromArgs(["--target=x86_64-unknown-linux-gnu,aarch64-apple-darwin"]), [
    "x86_64-unknown-linux-gnu",
    "aarch64-apple-darwin",
  ]);
});

test("resolveCliTargets prefers explicit env over host platform", () => {
  assert.deepEqual(
    resolveCliTargets({
      argv: [],
      env: { MUXPIT_CLI_TARGETS: "x86_64-pc-windows-msvc aarch64-apple-darwin" },
      platform: "linux",
      arch: "x64",
    }),
    ["x86_64-pc-windows-msvc", "aarch64-apple-darwin"],
  );
});

test("packaging paths are rooted in target sidecars and muxpit-cli target output", () => {
  assert.equal(
    sidecarOutputPathForTarget({ root: "/repo", target: "x86_64-pc-windows-msvc" }),
    join("/repo", "target", "sidecars", "muxpit-cli-x86_64-pc-windows-msvc.exe"),
  );
  assert.equal(
    cliOutputPathForTarget({
      root: "/repo",
      target: "x86_64-pc-windows-msvc",
      hostTriple: "x86_64-unknown-linux-gnu",
    }),
    join("/repo", "muxpit-cli", "target", "x86_64-pc-windows-msvc", "release", "muxpit-cli.exe"),
  );
  assert.equal(
    cliOutputPathForTarget({
      root: "/repo",
      target: "x86_64-unknown-linux-gnu",
      hostTriple: "x86_64-unknown-linux-gnu",
    }),
    join("/repo", "muxpit-cli", "target", "release", "muxpit-cli"),
  );
});
