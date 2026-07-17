#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

export const hostTripleFromPlatform = (
  platform = process.platform,
  arch = process.arch,
) => {
  if (platform === "win32") {
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
    if (arch === "ia32") return "i686-pc-windows-msvc";
    return "x86_64-pc-windows-msvc";
  }

  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }

  if (platform === "linux") {
    if (arch === "arm64") return "aarch64-unknown-linux-gnu";
    if (arch === "arm") return "armv7-unknown-linux-gnueabihf";
    return "x86_64-unknown-linux-gnu";
  }

  throw new Error(`unsupported host platform for muxpit-cli packaging: ${platform}/${arch}`);
};

export const cliExecutableNameForTarget = (target) =>
  target.includes("windows") ? "muxpit-cli.exe" : "muxpit-cli";

export const sidecarNameForTarget = (target) =>
  `${cliExecutableNameForTarget(target).replace(/\.exe$/, "")}-${target}${
    target.includes("windows") ? ".exe" : ""
  }`;

export const cliOutputPathForTarget = ({
  root = repoRoot,
  target,
  hostTriple = hostTripleFromPlatform(),
}) => {
  const fileName = cliExecutableNameForTarget(target);
  const targetDir = target === hostTriple ? join(root, "muxpit-cli", "target", "release") : join(root, "muxpit-cli", "target", target, "release");
  return join(targetDir, fileName);
};

export const sidecarOutputPathForTarget = ({ root = repoRoot, target }) =>
  join(root, "target", "sidecars", sidecarNameForTarget(target));

const splitTargets = (value) =>
  value
    .split(/[,\s]+/)
    .map((target) => target.trim())
    .filter(Boolean);

export const targetsFromArgs = (argv) => {
  const targets = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target" || arg === "-t") {
      const value = argv[index + 1];
      if (value) targets.push(...splitTargets(value));
      index += 1;
      continue;
    }
    if (arg.startsWith("--target=")) {
      targets.push(...splitTargets(arg.slice("--target=".length)));
    }
  }
  return targets;
};

export const resolveCliTargets = ({
  argv = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) => {
  const fromArgs = targetsFromArgs(argv);
  if (fromArgs.length > 0) return fromArgs;

  for (const key of [
    "MUXPIT_CLI_TARGETS",
    "MUXPIT_CLI_TARGET",
    "TAURI_ENV_TARGET_TRIPLE",
    "CARGO_BUILD_TARGET",
    "TARGET",
  ]) {
    const value = env[key];
    if (value) return splitTargets(value);
  }

  return [hostTripleFromPlatform(platform, arch)];
};

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
};

const buildCargoTarget = (target, hostTriple) => {
  const args = ["build", "--manifest-path", "muxpit-cli/Cargo.toml", "--release"];
  if (target !== hostTriple) args.push("--target", target);
  run("cargo", args);
};

const copySidecar = (target, hostTriple) => {
  const src = cliOutputPathForTarget({ target, hostTriple });
  const dest = sidecarOutputPathForTarget({ target });
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);

  if (!target.includes("windows")) {
    const mode = statSync(src).mode;
    chmodSync(dest, mode | 0o755);
  }

  console.log(`[muxpit] prepared CLI sidecar: ${dest}`);
};

const buildUniversalMacSidecar = (hostTriple) => {
  const targets = ["x86_64-apple-darwin", "aarch64-apple-darwin"];
  for (const target of targets) buildCargoTarget(target, hostTriple);

  const output = sidecarOutputPathForTarget({ target: "universal-apple-darwin" });
  mkdirSync(dirname(output), { recursive: true });
  run("lipo", [
    "-create",
    "-output",
    output,
    ...targets.map((target) => cliOutputPathForTarget({ target, hostTriple })),
  ]);
  chmodSync(output, statSync(output).mode | 0o755);
  console.log(`[muxpit] prepared CLI sidecar: ${output}`);
};

export const buildCliSidecars = (targets = resolveCliTargets()) => {
  const hostTriple = hostTripleFromPlatform();
  const uniqueTargets = [...new Set(targets)];

  for (const target of uniqueTargets) {
    if (target === "universal-apple-darwin") {
      buildUniversalMacSidecar(hostTriple);
      continue;
    }

    buildCargoTarget(target, hostTriple);
    copySidecar(target, hostTriple);
  }
};

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === scriptPath;

if (isDirectRun) {
  try {
    buildCliSidecars();
  } catch (error) {
    console.error(`[muxpit] failed to build CLI sidecars: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
