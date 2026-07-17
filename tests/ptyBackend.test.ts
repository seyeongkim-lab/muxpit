import test from "node:test";
import assert from "node:assert/strict";

import {
  spawnTerminalPty,
  type PtyBackend,
  type SpawnPtyRequest,
  type SpawnTmuxCcRequest,
} from "../src/utils/ptyBackend.ts";

const createBackend = () => {
  const calls: string[] = [];
  const spawnRequests: SpawnPtyRequest[] = [];
  const tmuxRequests: SpawnTmuxCcRequest[] = [];
  const backend: Pick<PtyBackend, "spawn" | "spawnTmuxCc"> = {
    spawn: async (request) => {
      calls.push("spawn");
      spawnRequests.push(request);
      return 1;
    },
    spawnTmuxCc: async (request) => {
      calls.push("spawnTmuxCc");
      tmuxRequests.push(request);
      return 2;
    },
  };
  return { backend, calls, spawnRequests, tmuxRequests };
};

const baseRequest = {
  rows: 24,
  cols: 80,
  spawnCommand: null,
  spawnCommandArgv: null,
  spawnSshConnection: null,
  tmuxSession: undefined,
  workspaceId: "ws",
  leafId: "leaf",
};

test("PTY backend spawn helper uses plain PTY by default", async () => {
  const { backend, calls } = createBackend();
  assert.equal(await spawnTerminalPty(backend, baseRequest), 1);
  assert.deepEqual(calls, ["spawn"]);
});

test("PTY backend spawn helper uses tmux-CC only with session and command", async () => {
  const { backend, calls } = createBackend();
  assert.equal(
    await spawnTerminalPty(backend, {
      ...baseRequest,
      spawnCommand: "ssh me@host",
      tmuxSession: "muxpit-host",
    }),
    2,
  );
  assert.deepEqual(calls, ["spawnTmuxCc"]);
});

test("PTY backend spawn helper falls back to plain PTY when tmux session has no command", async () => {
  const { backend, calls } = createBackend();
  assert.equal(
    await spawnTerminalPty(backend, {
      ...baseRequest,
      tmuxSession: "muxpit-host",
    }),
    1,
  );
  assert.deepEqual(calls, ["spawn"]);
});

test("PTY backend spawn helper forwards cwd only to plain PTY spawns", async () => {
  const { backend, spawnRequests, tmuxRequests } = createBackend();
  await spawnTerminalPty(backend, {
    ...baseRequest,
    cwd: "/home/me/project",
    enableCwdReporting: true,
  });
  assert.equal(spawnRequests[0].cwd, "/home/me/project");
  assert.equal(spawnRequests[0].enableCwdReporting, true);

  await spawnTerminalPty(backend, {
    ...baseRequest,
    spawnCommand: "ssh me@host",
    tmuxSession: "muxpit-host",
    cwd: "/home/me/project",
    enableCwdReporting: true,
  });
  assert.equal(tmuxRequests[0].sessionName, "muxpit-host");
  assert.equal(tmuxRequests.length, 1);
});

test("PTY backend spawn helper forwards agent session reporting only to plain PTY spawns", async () => {
  const { backend, spawnRequests } = createBackend();
  await spawnTerminalPty(backend, {
    ...baseRequest,
    spawnCommand: "codex",
    enableAgentSessionReporting: true,
  });

  assert.equal(spawnRequests[0].enableAgentSessionReporting, true);
});
