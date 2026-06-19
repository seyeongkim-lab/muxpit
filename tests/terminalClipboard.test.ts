import test from "node:test";
import assert from "node:assert/strict";

import {
  blobToBase64,
  createTerminalClipboard,
  type ClipboardLike,
} from "../src/utils/terminalClipboard.ts";

test("terminal clipboard reads the first available image blob", async () => {
  const image = new Blob(["image-bytes"], { type: "image/png" });
  const clipboard = createTerminalClipboard({
    read: async () => [
      {
        types: ["text/plain", "image/png"],
        getType: async (type) => {
          assert.equal(type, "image/png");
          return image;
        },
      },
    ],
  });

  assert.equal(await clipboard.readImage(), image);
});

test("terminal clipboard safely falls back when browser APIs are unavailable", async () => {
  const clipboard = createTerminalClipboard(undefined);

  assert.equal(await clipboard.readImage(), null);
  assert.equal(await clipboard.readText(), "");
  await clipboard.writeText("ignored");
});

test("terminal clipboard treats denied reads as empty clipboard", async () => {
  const clipboard = createTerminalClipboard({
    read: async () => {
      throw new Error("denied");
    },
    readText: async () => {
      throw new Error("denied");
    },
  });

  assert.equal(await clipboard.readImage(), null);
  assert.equal(await clipboard.readText(), "");
});

test("terminal clipboard writes text through the injected port", async () => {
  const writes: string[] = [];
  const clipboard = createTerminalClipboard({
    writeText: async (text) => {
      writes.push(text);
    },
  });

  await clipboard.writeText("copied");
  assert.deepEqual(writes, ["copied"]);
});

test("terminal clipboard converts blobs to raw base64", async () => {
  assert.equal(await blobToBase64(new Blob(["abc"])), "YWJj");
});

test("terminal clipboard skips image reads when no image type exists", async () => {
  const clipboardLike: ClipboardLike = {
    read: async () => [
      {
        types: ["text/plain"],
        getType: async () => {
          throw new Error("unexpected getType");
        },
      },
    ],
  };

  assert.equal(await createTerminalClipboard(clipboardLike).readImage(), null);
});
