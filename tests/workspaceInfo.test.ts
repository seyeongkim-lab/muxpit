import test from "node:test";
import assert from "node:assert/strict";

import { useWorkspaceInfoStore } from "../src/hooks/useWorkspaceInfo.ts";

test("patchInfo keeps the state reference for a no-op patch", () => {
  const { patchInfo } = useWorkspaceInfoStore.getState();

  patchInfo("ws", { aiStatusLabel: "reading files", aiStatusKind: "active" });
  const before = useWorkspaceInfoStore.getState().info;

  patchInfo("ws", { aiStatusLabel: "reading files", aiStatusKind: "active" });
  assert.equal(useWorkspaceInfoStore.getState().info, before);

  patchInfo("ws", { aiStatusLabel: "done" });
  assert.notEqual(useWorkspaceInfoStore.getState().info, before);
  assert.equal(useWorkspaceInfoStore.getState().info["ws"].aiStatusLabel, "done");
});
