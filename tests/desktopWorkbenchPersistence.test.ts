import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopLegacySnapshotKeys,
  loadDesktopWorkbenchSelection,
  saveDesktopWorkbenchSelection,
} from "../src/agent/desktopWorkbenchPersistence.ts";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("desktop selection restores the exact host provider and session", () => {
  const storage = new MemoryStorage();
  saveDesktopWorkbenchSelection(storage, {
    targetKey: "ssh:ssh:user@host:-p\u00002222",
    provider: "claude",
    sessionId: "session-42",
  });

  assert.deepEqual(
    loadDesktopWorkbenchSelection(storage, ["codex", "claude"] as const),
    {
      targetKey: "ssh:ssh:user@host:-p\u00002222",
      provider: "claude",
      sessionId: "session-42",
    },
  );
});

test("desktop selection rejects providers outside the installed client set", () => {
  const storage = new MemoryStorage();
  storage.setItem("muxpit-desktop-agent-selection-v1", JSON.stringify({
    version: 1,
    targetKey: "local",
    provider: "unknown",
    sessionId: "session-1",
  }));

  assert.equal(loadDesktopWorkbenchSelection(storage, ["codex", "claude"] as const), undefined);
});

test("legacy migration reads every cwd snapshot for the selected host", () => {
  const storage = new MemoryStorage();
  storage.setItem("muxpit-desktop-agent-workbench-v1:local|C:\\repo-a", "{}");
  storage.setItem("muxpit-desktop-agent-workbench-v1:local|C:\\repo-b", "{}");
  storage.setItem("muxpit-desktop-agent-workbench-v1:user@host|/repo-a", "{}");
  storage.setItem("unrelated", "{}");

  assert.deepEqual(desktopLegacySnapshotKeys(storage, ["local|"]), [
    "muxpit-desktop-agent-workbench-v1:local|C:\\repo-a",
    "muxpit-desktop-agent-workbench-v1:local|C:\\repo-b",
  ]);
  assert.deepEqual(desktopLegacySnapshotKeys(storage, ["user@host|"]), [
    "muxpit-desktop-agent-workbench-v1:user@host|/repo-a",
  ]);
});
