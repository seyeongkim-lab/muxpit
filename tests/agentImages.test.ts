import test from "node:test";
import assert from "node:assert/strict";

import {
  acpPromptBlocks,
  agentImageDataUrl,
  claudePromptLine,
  codexPromptInput,
  createAgentImageAttachments,
  imageBlobsFromClipboard,
  promptTimelineText,
} from "../src/agent/agentImages.ts";

const png = (bytes: number, name = "clipboard.png"): Blob => {
  const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
  Object.defineProperty(blob, "name", { value: name });
  return blob;
};

test("agent image attachments keep supported clipboard images as base64", async () => {
  const [attachment] = await createAgentImageAttachments([png(3)]);

  assert.equal(attachment.name, "clipboard.png");
  assert.equal(attachment.mimeType, "image/png");
  assert.equal(attachment.size, 3);
  assert.equal(attachment.data, "AAAA");
  assert.match(attachment.id, /^image-/);
  assert.equal(agentImageDataUrl(attachment), "data:image/png;base64,AAAA");
});

test("agent image attachments enforce count and aggregate size limits", async () => {
  await assert.rejects(
    createAgentImageAttachments([png(1), png(1), png(1), png(1), png(1)]),
    /up to 4 images/i,
  );
  await assert.rejects(
    createAgentImageAttachments([png(5 * 1024 * 1024), png(4 * 1024 * 1024)]),
    /8 MB/i,
  );
});

test("clipboard image extraction reads image items and ignores text", () => {
  const image = png(2);
  assert.deepEqual(imageBlobsFromClipboard({
    items: [
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "file", type: "image/png", getAsFile: () => image },
    ],
  }), [image]);
});

test("Codex prompt input combines text and data URL images", async () => {
  const [attachment] = await createAgentImageAttachments([png(3)]);

  assert.deepEqual(codexPromptInput("Inspect this", [attachment]), [
    { type: "text", text: "Inspect this", text_elements: [] },
    { type: "image", url: "data:image/png;base64,AAAA", detail: "auto" },
  ]);
});

test("Claude streaming input combines text and base64 images", async () => {
  const [attachment] = await createAgentImageAttachments([png(3)]);

  assert.deepEqual(JSON.parse(claudePromptLine("Inspect this", [attachment])), {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: "Inspect this" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AAAA" },
        },
      ],
    },
    parent_tool_use_id: null,
  });
});

test("ACP prompt blocks and image-only timeline labels include attachments", async () => {
  const [attachment] = await createAgentImageAttachments([png(3)]);

  assert.deepEqual(acpPromptBlocks("Inspect this", [attachment]), [
    { type: "text", text: "Inspect this" },
    { type: "image", mimeType: "image/png", data: "AAAA" },
  ]);
  assert.equal(promptTimelineText("", [attachment]), "[1 image]");
  assert.equal(promptTimelineText("Inspect this", [attachment, attachment]), "Inspect this\n\n[2 images]");
});
