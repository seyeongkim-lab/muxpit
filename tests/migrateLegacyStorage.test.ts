import test from "node:test";
import assert from "node:assert/strict";

import { migrateLegacyStorage } from "../src/utils/migrateLegacyStorage.ts";

const makeStorage = (initial: Record<string, string> = {}): Storage => {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    removeItem(key: string) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
  } as Storage;
};

test("copies legacy wmux-* keys to muxpit-* keys", () => {
  const storage = makeStorage({
    "wmux-ssh-hosts": "[1]",
    "wmux-launch-profiles": "[2]",
    "wmux-desktop-agent-workbench-v2:abc": "{}",
    "wmux-session:desktop": "{}",
    "unrelated-key": "keep",
  });

  migrateLegacyStorage(storage);

  assert.equal(storage.getItem("muxpit-ssh-hosts"), "[1]");
  assert.equal(storage.getItem("muxpit-launch-profiles"), "[2]");
  assert.equal(storage.getItem("muxpit-desktop-agent-workbench-v2:abc"), "{}");
  assert.equal(storage.getItem("muxpit-session:desktop"), "{}");
  assert.equal(storage.getItem("unrelated-key"), "keep");
});

test("never overwrites an existing muxpit-* key", () => {
  const storage = makeStorage({
    "wmux-settings": "old",
    "muxpit-settings": "new",
  });

  migrateLegacyStorage(storage);

  assert.equal(storage.getItem("muxpit-settings"), "new");
});

test("runs only once via the migrated flag", () => {
  const storage = makeStorage({ "wmux-ssh-hosts": "[1]" });

  migrateLegacyStorage(storage);
  assert.equal(storage.getItem("muxpit-legacy-localstorage-migrated"), "1");

  // A later user edit that clears the migrated key must not be resurrected.
  storage.removeItem("muxpit-ssh-hosts");
  migrateLegacyStorage(storage);
  assert.equal(storage.getItem("muxpit-ssh-hosts"), null);
});

test("is a no-op when there are no legacy keys", () => {
  const storage = makeStorage({ "muxpit-ssh-hosts": "[1]" });
  migrateLegacyStorage(storage);
  assert.equal(storage.getItem("muxpit-ssh-hosts"), "[1]");
});
