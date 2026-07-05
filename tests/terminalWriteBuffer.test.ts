import test from "node:test";
import assert from "node:assert/strict";

import type { WriteScheduler } from "../src/utils/terminalWriteBuffer.ts";
import { createTerminalWriteBuffer } from "../src/utils/terminalWriteBuffer.ts";

const createManualScheduler = () => {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const scheduler: WriteScheduler = {
    request(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
    },
  };
  return {
    scheduler,
    runAll() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback());
    },
    get pendingCount() {
      return callbacks.size;
    },
  };
};

test("terminal write buffer coalesces chunks into one scheduled write", () => {
  const manual = createManualScheduler();
  const writes: string[] = [];
  const buffer = createTerminalWriteBuffer((data) => writes.push(data), manual.scheduler);

  buffer.write("a");
  buffer.write("b");

  assert.equal(manual.pendingCount, 1);
  assert.deepEqual(writes, []);

  manual.runAll();
  assert.deepEqual(writes, ["ab"]);
});

test("terminal write buffer flush preserves ordering before direct status writes", () => {
  const manual = createManualScheduler();
  const writes: string[] = [];
  const buffer = createTerminalWriteBuffer((data) => writes.push(data), manual.scheduler);

  buffer.write("output");
  buffer.flush();
  writes.push("status");

  assert.equal(manual.pendingCount, 0);
  assert.deepEqual(writes, ["output", "status"]);
});

test("terminal write buffer flushes immediately after high water mark", () => {
  const manual = createManualScheduler();
  const writes: string[] = [];
  const buffer = createTerminalWriteBuffer((data) => writes.push(data), manual.scheduler, 3);

  buffer.write("ab");
  buffer.write("cd");

  assert.equal(manual.pendingCount, 0);
  assert.deepEqual(writes, ["abcd"]);
});
