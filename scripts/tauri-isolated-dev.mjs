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

const main = async () => {
  const namespace = randomNamespace();
  const port = await findAvailablePort();
  const tmpDir = await mkdtemp(join(tmpdir(), "wmux-tauri-"));
  const isolatedConfigPath = join(tmpDir, "isolated.conf.json");

  try {
    const config = JSON.parse(await readFile(tauriConfigPath, "utf8"));
    config.build = {
      ...config.build,
      devUrl: `http://127.0.0.1:${port}`,
      beforeDevCommand:
        `pnpm --ignore-workspace exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    };

    await writeFile(isolatedConfigPath, `${JSON.stringify(config, null, 2)}\n`);

    const env = { ...process.env, WMUX_IPC_NAMESPACE: namespace };
    delete env.WMUX_SOCKET_PATH;
    delete env.WMUX_PIPE_NAME;

    console.log(`[wmux] isolated IPC namespace: ${namespace}`);
    console.log(`[wmux] isolated dev server: http://127.0.0.1:${port}`);
    console.log(
      "[wmux] external CLI example: " +
        `env -u WMUX_SOCKET_PATH -u WMUX_PIPE_NAME WMUX_IPC_NAMESPACE=${namespace} wmux-cli ping`,
    );

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
  console.error(`[wmux] isolated dev failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
