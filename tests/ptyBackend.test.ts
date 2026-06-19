import test from "node:test";
import assert from "node:assert/strict";

import { spawnTerminalPty, type PtyBackend } from "../src/utils/ptyBackend.ts";

const createBackend = () => {
  const calls: string[] = [];
  const backend: Pick<PtyBackend, "spawn" | "spawnTmuxCc"> = {
    spawn: async () => {
      calls.push("spawn");
      return 1;
    },
    spawnTmuxCc: async () => {
      calls.push("spawnTmuxCc");
      return 2;
    },
  };
  return { backend, calls };
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
      tmuxSession: "wmux-host",
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
      tmuxSession: "wmux-host",
    }),
    1,
  );
  assert.deepEqual(calls, ["spawn"]);
});
