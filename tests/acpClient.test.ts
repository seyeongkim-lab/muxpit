import test from "node:test";
import assert from "node:assert/strict";

import {
  AcpClient,
  automaticPermissionOptionId,
  normalizeAcpMessage,
} from "../src/agent/acpClient.ts";
import type { AgentImageAttachment } from "../src/agent/agentImages.ts";

const attachment: AgentImageAttachment = {
  id: "image-1",
  name: "clipboard.png",
  mimeType: "image/png",
  data: "AAAA",
  size: 3,
};

test("ACP client initializes and lists sessions when supported", async () => {
  const sent: Record<string, unknown>[] = [];
  const events: unknown[] = [];
  const client = new AcpClient(
    "copilot",
    async (line) => { sent.push(JSON.parse(line) as Record<string, unknown>); },
    (event) => { events.push(event); },
  );

  const initializing = client.initialize();
  await Promise.resolve();
  assert.deepEqual(sent[0], {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "muxpit", title: "muxpit", version: "0.2.17" },
    },
  });
  client.receive(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent[1].method, "session/list");
  client.receive(JSON.stringify({
    jsonrpc: "2.0",
    id: sent[1].id,
    result: {
      sessions: [{ sessionId: "session-1", cwd: "/repo", title: "Fix tests", updatedAt: "2026-07-15T01:00:00Z" }],
    },
  }));
  await initializing;
  assert.deepEqual(events, [{
    type: "sessionsLoaded",
    sessions: [{
      id: "session-1",
      cwd: "/repo",
      title: "Fix tests",
      updatedAt: Date.parse("2026-07-15T01:00:00Z") / 1000,
      provider: "copilot",
    }],
  }]);
});

test("ACP updates become messages, tools, and approval requests", () => {
  assert.deepEqual(normalizeAcpMessage("opencode", {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "수정 중" },
      },
    },
  }), [{
    type: "messageDelta",
    sessionId: "session-1",
    turnId: "session-1",
    itemId: "message-1",
    text: "수정 중",
  }]);

  assert.deepEqual(normalizeAcpMessage("opencode", {
    jsonrpc: "2.0",
    id: 9,
    method: "session/request_permission",
    params: {
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1", title: "Run tests", rawInput: { command: "pnpm test" } },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
    },
  }), [{
    type: "approvalRequested",
    requestId: 9,
    sessionId: "session-1",
    turnId: "session-1",
    itemId: "tool-1",
    title: "Run tests",
    detail: "{\"command\":\"pnpm test\"}",
    options: [{ id: "allow-once", label: "Allow once", kind: "allow_once" }],
  }]);
});

test("ACP client sends new, load, prompt, cancel, and permission shapes", async () => {
  const sent: Record<string, unknown>[] = [];
  const client = new AcpClient(
    "gemini",
    async (line) => { sent.push(JSON.parse(line) as Record<string, unknown>); },
    () => {},
  );

  const initializing = client.initialize();
  await Promise.resolve();
  client.receive(JSON.stringify({
    jsonrpc: "2.0",
    id: sent[0].id,
    result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
    },
  }));
  await initializing;
  sent.length = 0;

  void client.newSession("/repo");
  await Promise.resolve();
  assert.deepEqual(sent[0], {
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: "/repo", mcpServers: [] },
  });

  void client.loadSession("session-1", "/repo");
  await Promise.resolve();
  assert.equal(sent[1].method, "session/load");

  void client.prompt("session-1", "테스트도 실행해", [attachment]);
  await Promise.resolve();
  assert.deepEqual(sent[2].params, {
    sessionId: "session-1",
    prompt: [
      { type: "text", text: "테스트도 실행해" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
    ],
  });

  await client.cancel("session-1");
  assert.deepEqual(sent[3], {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: "session-1" },
  });

  await client.resolvePermission(12, "allow-once");
  assert.deepEqual(sent[4], {
    jsonrpc: "2.0",
    id: 12,
    result: { outcome: { outcome: "selected", optionId: "allow-once" } },
  });
});

test("ACP client rejects images when the provider does not advertise support", async () => {
  const sent: Record<string, unknown>[] = [];
  const client = new AcpClient(
    "opencode",
    async (line) => { sent.push(JSON.parse(line) as Record<string, unknown>); },
    () => {},
  );
  const initializing = client.initialize();
  await Promise.resolve();
  client.receive(JSON.stringify({
    jsonrpc: "2.0",
    id: sent[0].id,
    result: { protocolVersion: 1, agentCapabilities: {} },
  }));
  await initializing;

  await assert.rejects(client.prompt("session-1", "Inspect", [attachment]), /does not support images/i);
});

test("automatic ACP permission prefers a persistent allow option", () => {
  assert.equal(automaticPermissionOptionId([
    { id: "deny", label: "Deny", kind: "reject_once" },
    { id: "once", label: "Allow once", kind: "allow_once" },
    { id: "always", label: "Always allow", kind: "allow_always" },
  ]), "always");
  assert.equal(automaticPermissionOptionId([
    { id: "once", label: "Allow once", kind: "allow_once" },
  ]), "once");
});
