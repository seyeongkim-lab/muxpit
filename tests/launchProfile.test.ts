import test from "node:test";
import assert from "node:assert/strict";

import {
  captureLaunchProfile,
  materializeLaunchProfile,
} from "../src/utils/launchProfile.ts";
import type { Workspace } from "../src/stores/workspace.ts";

const workspace: Workspace = {
  id: "ws",
  name: "project",
  nameSource: "manual",
  focusedLeafId: "terminal",
  layout: {
    type: "split",
    id: "split",
    direction: "vertical",
    ratio: 0.6,
    children: [
      {
        type: "leaf",
        id: "terminal",
        ptyId: 42,
        command: "pnpm dev",
        lastCwd: "/work/project",
      },
      { type: "browser", id: "browser", url: "http://localhost:5173" },
    ],
  },
};

test("launch profile captures commands cwd browser URL and split geometry", () => {
  const profile = captureLaunchProfile("dev", workspace, 100);
  assert.ok(profile);
  assert.equal(profile.name, "dev");
  assert.equal(profile.layout.type, "split");
  if (profile.layout.type !== "split") return;
  assert.equal(profile.layout.children[0].type, "terminal");
  assert.deepEqual(profile.layout.children[0], {
    type: "terminal",
    sourceSurfaceId: "terminal",
    command: "pnpm dev",
    cwd: "/work/project",
  });
  assert.deepEqual(profile.layout.children[1], {
    type: "browser",
    url: "http://localhost:5173",
  });
});

test("materialized profile remaps subagent parent surface ids", () => {
  const profile = captureLaunchProfile("agents", {
    ...workspace,
    layout: {
      type: "split",
      id: "agents-split",
      direction: "vertical",
      ratio: 0.5,
      children: [
        { type: "leaf", id: "parent", ptyId: 1, command: "codex" },
        {
          type: "leaf",
          id: "child",
          ptyId: 2,
          command: "codex",
          agentRole: "subagent",
          parentSurfaceId: "parent",
          agentLabel: "reviewer",
        },
      ],
    },
  }, 100)!;
  let id = 0;
  const materialized = materializeLaunchProfile(profile, () => `fresh-${id++}`);

  assert.equal(materialized.layout.type, "split");
  if (materialized.layout.type !== "split") return;
  const child = materialized.layout.children[1];
  assert.equal(child.type, "leaf");
  if (child.type !== "leaf") return;
  assert.equal(child.parentSurfaceId, "fresh-1");
});

test("materialized profile receives fresh node ids and focused terminal", () => {
  const profile = captureLaunchProfile("dev", workspace, 100)!;
  let id = 0;
  const materialized = materializeLaunchProfile(profile, () => `new-${id++}`);
  assert.equal(materialized.layout.id, "new-0");
  assert.equal(materialized.focusedLeafId, "new-1");
  if (materialized.layout.type !== "split") return;
  assert.equal(materialized.layout.children[0].id, "new-1");
  assert.equal(materialized.layout.children[0].type, "leaf");
  if (materialized.layout.children[0].type !== "leaf") return;
  assert.equal(materialized.layout.children[0].ptyId, null);
  assert.equal(materialized.layout.children[0].lastCwd, "/work/project");
});

test("launch profile rejects runtime monitor panes", () => {
  const unsupported: Workspace = {
    ...workspace,
    layout: {
      type: "monitor",
      id: "monitor",
      monitorId: "running-monitor",
      sshTarget: "host",
    },
  };
  assert.equal(captureLaunchProfile("bad", unsupported, 100), null);
});
