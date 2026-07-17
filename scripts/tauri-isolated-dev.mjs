import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const repoRoot = process.cwd();
const tauriConfigPath = join(repoRoot, "src-tauri", "tauri.conf.json");

const randomNamespace = () =>
  `dev-${process.pid}-${randomBytes(6).toString("hex")}`;

const isolatedAppIdentity = (namespace) => {
  const match = /^dev-(\d+)-([0-9a-f]+)$/i.exec(namespace);
  if (!match) {
    throw new Error(`unexpected isolated namespace format: ${namespace}`);
  }
  const [, pid, hex] = match;
  return {
    identifier: `com.muxpit.terminal.isolated.i${hex.toLowerCase()}`,
    productName: `muxpit-dev-${pid}-${hex.toLowerCase()}`,
    title: `muxpit isolated ${hex.slice(0, 6).toLowerCase()}`,
  };
};

const findAvailablePort = async () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("failed to allocate a dev server port"));
          return;
        }
        resolve(address.port);
      });
    });
  });

const run = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });

    const forwardSigint = () => {
      if (!child.killed) child.kill("SIGINT");
    };
    const forwardSigterm = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    process.once("SIGINT", forwardSigint);
    process.once("SIGTERM", forwardSigterm);

    child.once("error", (error) => {
      process.off("SIGINT", forwardSigint);
      process.off("SIGTERM", forwardSigterm);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      process.off("SIGINT", forwardSigint);
      process.off("SIGTERM", forwardSigterm);
      if (signal) {
        resolve(128);
        return;
      }
      resolve(code ?? 0);
    });
  });

const cliExample = (namespace) => {
  if (process.platform === "win32") {
    return (
      "powershell -NoProfile -Command " +
      `"Remove-Item Env:MUXPIT_SOCKET_PATH,Env:MUXPIT_PIPE_NAME -ErrorAction SilentlyContinue; ` +
      `$env:MUXPIT_IPC_NAMESPACE='${namespace}'; muxpit-cli ping"`
    );
  }
  return `env -u MUXPIT_SOCKET_PATH -u MUXPIT_PIPE_NAME MUXPIT_IPC_NAMESPACE=${namespace} muxpit-cli ping`;
};

const main = async () => {
  const namespace = randomNamespace();
  const port = await findAvailablePort();
  const tmpDir = await mkdtemp(join(tmpdir(), "muxpit-tauri-"));
  const isolatedConfigPath = join(tmpDir, "isolated.conf.json");

  try {
    const config = JSON.parse(await readFile(tauriConfigPath, "utf8"));
    const identity = isolatedAppIdentity(namespace);
    config.identifier = identity.identifier;
    config.productName = identity.productName;
    config.build = {
      ...config.build,
      devUrl: `http://127.0.0.1:${port}`,
      beforeDevCommand:
        `pnpm --ignore-workspace exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    };
    config.app = {
      ...config.app,
      windows: (config.app?.windows ?? []).map((windowConfig) => ({
        ...windowConfig,
        title: identity.title,
      })),
    };

    await writeFile(isolatedConfigPath, `${JSON.stringify(config, null, 2)}\n`);

    const env = { ...process.env, MUXPIT_IPC_NAMESPACE: namespace };
    delete env.MUXPIT_SOCKET_PATH;
    delete env.MUXPIT_PIPE_NAME;

    console.log(`[muxpit] isolated IPC namespace: ${namespace}`);
    console.log(`[muxpit] isolated app identifier: ${identity.identifier}`);
    console.log(`[muxpit] isolated dev server: http://127.0.0.1:${port}`);
    console.log("[muxpit] external CLI example: " + cliExample(namespace));

    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const code = await run(
      pnpm,
      ["--ignore-workspace", "tauri", "dev", "--config", isolatedConfigPath],
      { cwd: repoRoot, env },
    );
    process.exitCode = code;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(`[muxpit] isolated dev failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
