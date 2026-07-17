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
  assert.equal((sent[0].params as { clientInfo: { version: string } }).clientInfo.version, "0.2.9");
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

  void client.startTurn("thread-1", "첫 작업", "/repo", {
    model: "gpt-test",
    effort: "high",
    serviceTier: "fast",
  });
  await Promise.resolve();
  assert.deepEqual(sent[0].params, {
    threadId: "thread-1",
    input: [{ type: "text", text: "첫 작업" }],
    cwd: "/repo",
    model: "gpt-test",
    effort: "high",
    serviceTier: "fast",
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

test("Codex mobile client loads model capabilities and applies thread settings", async () => {
  const sent: Record<string, unknown>[] = [];
  const events: unknown[] = [];
  const client = new CodexMobileClient(
    async (line) => { sent.push(JSON.parse(line) as Record<string, unknown>); },
    (event) => { events.push(event); },
  );

  const loadingModels = client.listModels();
  await Promise.resolve();
  assert.equal(sent[0].method, "model/list");
  client.receive(JSON.stringify({
    id: sent[0].id,
    result: {
      data: [{
        id: "gpt-test",
        model: "gpt-test",
        displayName: "GPT Test",
        description: "Test model",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "high", description: "More reasoning" },
        ],
        defaultServiceTier: null,
        serviceTiers: [{ id: "fast", name: "Fast", description: "Faster output" }],
      }],
    },
  }));
  assert.deepEqual(await loadingModels, [{
    id: "gpt-test",
    model: "gpt-test",
    displayName: "GPT Test",
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["medium", "high"],
    defaultServiceTier: null,
    serviceTiers: [{ id: "fast", name: "Fast" }],
  }]);
  assert.deepEqual(events, []);

  const starting = client.startSession("/repo", {
    model: "gpt-test",
    effort: "high",
    serviceTier: "fast",
  });
  await Promise.resolve();
  assert.deepEqual(sent[1].params, {
    cwd: "/repo",
    model: "gpt-test",
    serviceTier: "fast",
  });
  client.receive(JSON.stringify({
    id: sent[1].id,
    result: {
      thread: { id: "thread-2" },
      model: "gpt-test",
      reasoningEffort: "medium",
      serviceTier: "fast",
    },
  }));
  assert.deepEqual(await starting, {
    threadId: "thread-2",
    settings: { model: "gpt-test", effort: "medium", serviceTier: "fast" },
  });

  void client.updateSessionSettings("thread-2", {
    model: "gpt-test",
    effort: "high",
    serviceTier: null,
  });
  await Promise.resolve();
  assert.equal(sent[2].method, "thread/settings/update");
  assert.deepEqual(sent[2].params, {
    threadId: "thread-2",
    model: "gpt-test",
    effort: "high",
    serviceTier: null,
  });
});

test("Codex mobile client does not confuse incoming requests with responses", async () => {
  const sent: Record<string, unknown>[] = [];
  const client = new CodexMobileClient(
    async (line) => { sent.push(JSON.parse(line) as Record<string, unknown>); },
    () => {},
  );

  let settled = false;
  const loading = client.listModels().then((models) => {
    settled = true;
    return models;
  });
  await Promise.resolve();
  client.receive(JSON.stringify({
    id: sent[0].id,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1" },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false);

  client.receive(JSON.stringify({ id: sent[0].id, result: { data: [] } }));
  assert.deepEqual(await loading, []);
});
