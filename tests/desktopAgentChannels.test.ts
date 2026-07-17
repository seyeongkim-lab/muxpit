import test from "node:test";
import assert from "node:assert/strict";
import {
  desktopAgentChannelId,
  newDesktopAgentChannelNamespace,
} from "../src/agent/desktopAgentChannels.ts";

test("desktop target runtimes use distinct agent channel ids", () => {
  const firstNamespace = newDesktopAgentChannelNamespace();
  const secondNamespace = newDesktopAgentChannelNamespace();

  assert.notEqual(firstNamespace, secondNamespace);
  assert.notEqual(
    desktopAgentChannelId(firstNamespace, "codex", "provider", 1_721_234_567_890, 1),
    desktopAgentChannelId(secondNamespace, "codex", "provider", 1_721_234_567_890, 1),
  );
});

test("desktop agent channel ids satisfy the native channel contract", () => {
  const channelId = desktopAgentChannelId(
    "123e4567-e89b-12d3-a456-426614174000",
    "claude",
    "claude-history",
    1_721_234_567_890,
    12,
  );

  assert.ok(channelId.length <= 128);
  assert.match(channelId, /^[A-Za-z0-9_.:-]+$/);
});
