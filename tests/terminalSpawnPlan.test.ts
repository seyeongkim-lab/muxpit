import test from "node:test";
import assert from "node:assert/strict";

import { buildTerminalSpawnPlan } from "../src/utils/terminalSpawnPlan.ts";

const baseSettings = {
  enableCwdRestore: false,
  enableAgentSessionRestore: true,
  enableAgentDangerousResume: false,
};

test("terminal spawn plan restores direct agents at spawn time with argv", () => {
  const plan = buildTerminalSpawnPlan({
    spec: {
      command: "codex",
      agentSession: {
        kind: "codex",
        sessionId: "11111111-2222-3333-4444-555555555555",
        baseCommand: "codex",
        updatedAt: 10,
      },
    },
    resolved: {
      command: "codex",
      commandArgv: null,
      sshConnection: null,
    },
    settings: baseSettings,
  });

  assert.equal(plan.spawnCommand, "codex resume 11111111-2222-3333-4444-555555555555");
  assert.deepEqual(plan.spawnCommandArgv, [
    "codex",
    "resume",
    "11111111-2222-3333-4444-555555555555",
  ]);
  assert.equal(plan.enableAgentSessionReporting, true);
  assert.equal(plan.postSpawnInput, undefined);
  assert.equal(plan.suppressShellHistoryHook, true);
});

test("terminal spawn plan uses current dangerous setting and strips saved dangerous base flags", () => {
  const spec = {
    command: "codex --dangerously-bypass-approvals-and-sandbox --profile work",
    agentSession: {
      kind: "codex" as const,
      sessionId: "11111111-2222-3333-4444-555555555555",
      baseCommand: "codex --dangerously-bypass-approvals-and-sandbox --profile work",
      updatedAt: 10,
    },
  };
  const safePlan = buildTerminalSpawnPlan({
    spec,
    resolved: {
      command: "codex --dangerously-bypass-approvals-and-sandbox --profile work",
      commandArgv: null,
      sshConnection: null,
    },
    settings: baseSettings,
  });

  assert.equal(
    safePlan.spawnCommand,
    "codex --profile work resume 11111111-2222-3333-4444-555555555555",
  );

  const dangerousPlan = buildTerminalSpawnPlan({
    spec,
    resolved: {
      command: "codex --dangerously-bypass-approvals-and-sandbox --profile work",
      commandArgv: null,
      sshConnection: null,
    },
    settings: { ...baseSettings, enableAgentDangerousResume: true },
  });

  assert.equal(
    dangerousPlan.spawnCommand,
    "codex --profile work resume --dangerously-bypass-approvals-and-sandbox 11111111-2222-3333-4444-555555555555",
  );
});

test("terminal spawn plan prefers sanitized base argv when spawning direct agents", () => {
  const plan = buildTerminalSpawnPlan({
    spec: {
      command: "'/tools/my codex/codex' --profile work",
      agentSession: {
        kind: "codex",
        sessionId: "11111111-2222-3333-4444-555555555555",
        baseCommand: "'/tools/my codex/codex' --profile work",
        baseCommandArgv: ["/tools/my codex/codex", "--profile", "work"],
        updatedAt: 10,
      },
    },
    resolved: {
      command: "'/tools/my codex/codex' --profile work",
      commandArgv: null,
      sshConnection: null,
    },
    settings: baseSettings,
  });

  assert.deepEqual(plan.spawnCommandArgv, [
    "/tools/my codex/codex",
    "--profile",
    "work",
    "resume",
    "11111111-2222-3333-4444-555555555555",
  ]);
});

test("terminal spawn plan restores shell-origin agents as post-spawn shell input", () => {
  const plan = buildTerminalSpawnPlan({
    spec: {
      agentSession: {
        kind: "claude",
        sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        cwd: "/home/me/project",
        updatedAt: 10,
      },
      cwd: "/home/me/project",
      cwdSource: "agent",
    },
    resolved: {
      command: null,
      commandArgv: null,
      sshConnection: null,
    },
    settings: { ...baseSettings, enableAgentDangerousResume: true },
  });

  assert.equal(plan.spawnCommand, null);
  assert.equal(
    plan.postSpawnInput,
    "claude --dangerously-skip-permissions --resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\r",
  );
  assert.equal(plan.cwd, "/home/me/project");
  assert.equal(plan.enableAgentSessionReporting, true);
  assert.equal(plan.suppressShellHistoryHook, true);
});

test("terminal spawn plan disables agent restore and cwd when setting is off", () => {
  const plan = buildTerminalSpawnPlan({
    spec: {
      command: "codex",
      cwd: "/home/me/project",
      cwdSource: "agent",
      agentSession: {
        kind: "codex",
        sessionId: "11111111-2222-3333-4444-555555555555",
        baseCommand: "codex",
        updatedAt: 10,
      },
    },
    resolved: {
      command: "codex",
      commandArgv: null,
      sshConnection: null,
    },
    settings: { ...baseSettings, enableAgentSessionRestore: false },
  });

  assert.equal(plan.spawnCommand, "codex");
  assert.equal(plan.spawnCommandArgv, null);
  assert.equal(plan.cwd, null);
  assert.equal(plan.enableAgentSessionReporting, false);
  assert.equal(plan.postSpawnInput, undefined);
});

test("terminal spawn plan always honors explicit launch cwd", () => {
  const plan = buildTerminalSpawnPlan({
    spec: {
      command: "codex",
      cwd: "/work/project",
      cwdSource: "launch",
    },
    resolved: {
      command: "codex",
      commandArgv: null,
      sshConnection: null,
    },
    settings: { ...baseSettings, enableCwdRestore: false },
  });

  assert.equal(plan.cwd, "/work/project");
});

test("terminal spawn plan does not report or restore across SSH and tmux boundaries", () => {
  const sshPlan = buildTerminalSpawnPlan({
    spec: {
      command: "ssh me@example.com",
      commandArgv: ["ssh", "me@example.com"],
      sshConnection: {
        program: "ssh",
        options: [],
        target: "me@example.com",
      },
      agentSession: {
        kind: "codex",
        sessionId: "11111111-2222-3333-4444-555555555555",
        updatedAt: 10,
      },
    },
    resolved: {
      command: "ssh me@example.com",
      commandArgv: ["ssh", "me@example.com"],
      sshConnection: {
        program: "ssh",
        options: [],
        target: "me@example.com",
      },
    },
    settings: baseSettings,
  });

  assert.equal(sshPlan.enableAgentSessionReporting, false);
  assert.equal(sshPlan.postSpawnInput, undefined);

  const tmuxPlan = buildTerminalSpawnPlan({
    spec: {
      command: "codex",
      agentSession: {
        kind: "codex",
        sessionId: "11111111-2222-3333-4444-555555555555",
        baseCommand: "codex",
        updatedAt: 10,
      },
    },
    resolved: {
      command: "codex",
      commandArgv: null,
      sshConnection: null,
    },
    tmuxSession: "wmux-host",
    settings: baseSettings,
  });

  assert.equal(tmuxPlan.spawnCommand, "codex");
  assert.equal(tmuxPlan.enableAgentSessionReporting, false);
});
