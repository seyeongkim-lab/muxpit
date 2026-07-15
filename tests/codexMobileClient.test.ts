import test from "node:test";
import assert from "node:assert/strict";

import { CodexMobileClient } from "../src/mobile/codexMobileClient.ts";

test("Codex mobile client initializes before listing sessions", async () => {
  const sent: Record<string, unknown>[] = [];
  const events: unknown[] = [];
  const client = new CodexMobileClient(
    async (line) => { sent.push(JSON.parse(line) as Record<string, unknown>); },
    (event) => { events.push(event); },
  );

  const initializing = client.initialize();
  await Promise.resolve();
  assert.equal(sent[0].method, "initialize");
  assert.equal((sent[0].params as { clientInfo: { version: string } }).clientInfo.version, "0.2.3");
  client.receive(JSON.stringify({ id: sent[0].id, result: { userAgent: "codex" } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent[1].method, "initialized");
  assert.equal(sent[2].method, "thread/list");
  client.receive(JSON.stringify({ id: sent[2].id, result: { data: [] } }));
  await initializing;
  assert.deepEqual(events, [{ type: "sessionsLoaded", sessions: [] }]);
});

test("Codex mobile client sends turn, steer, interrupt, and approval shapes", async () => {
  const sent: Record<string, unknown>[] = [];
  const client = new CodexMobileClient(
    async (line) => { sent.push(JSON.parse(line) as Record<string, unknown>); },
    () => {},
  );

  void client.startTurn("thread-1", "첫 작업", "/repo");
  await Promise.resolve();
  assert.deepEqual(sent[0].params, {
    threadId: "thread-1",
    input: [{ type: "text", text: "첫 작업" }],
    cwd: "/repo",
  });

  void client.steer("thread-1", "turn-1", "테스트도 실행해");
  await Promise.resolve();
  assert.deepEqual(sent[1].params, {
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: "테스트도 실행해" }],
  });

  void client.interrupt("thread-1", "turn-1");
  await Promise.resolve();
  assert.equal(sent[2].method, "turn/interrupt");

  await client.resolveApproval(42, true);
  assert.deepEqual(sent[3], { id: 42, result: { decision: "accept" } });
});
