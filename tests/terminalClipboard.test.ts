import test from "node:test";
import assert from "node:assert/strict";

import {
  blobToBase64,
  createTerminalClipboard,
  encodeRgbaToPngBlob,
  normalizeImageBlobToPng,
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
  }, async () => null);

  assert.equal(await clipboard.readImage(), image);
});

test("terminal clipboard safely falls back when browser APIs are unavailable", async () => {
  const clipboard = createTerminalClipboard(undefined, async () => null);

  assert.equal(await clipboard.readImage(), null);
  assert.equal(await clipboard.readText(), "");
  await clipboard.writeText("ignored");
});

test("terminal clipboard treats denied reads as empty clipboard", async () => {
  const clipboard = createTerminalClipboard(
    {
      read: async () => {
        throw new Error("denied");
      },
      readText: async () => {
        throw new Error("denied");
      },
    },
    async () => null,
  );

  assert.equal(await clipboard.readImage(), null);
  assert.equal(await clipboard.readText(), "");
});

test("terminal clipboard writes text through the injected port", async () => {
  const writes: string[] = [];
  const clipboard = createTerminalClipboard({
    writeText: async (text) => {
      writes.push(text);
    },
  }, async () => null);

  await clipboard.writeText("copied");
  assert.deepEqual(writes, ["copied"]);
});

test("terminal clipboard prefers native image reads when available", async () => {
  const encoded = new Blob(["png"], { type: "image/png" });
  const closed: string[] = [];
  const clipboard = createTerminalClipboard(
    {
      read: async () => {
        throw new Error("unexpected browser image fallback");
      },
    },
    async () => ({
      readImage: async () => ({
        rgba: async () => new Uint8Array([255, 0, 0, 255]),
        size: async () => ({ width: 1, height: 1 }),
        close: async () => closed.push("closed"),
      }),
    }),
    async ({ rgba, width, height }) => {
      assert.deepEqual([...rgba], [255, 0, 0, 255]);
      assert.equal(width, 1);
      assert.equal(height, 1);
      return encoded;
    },
  );

  assert.equal(await clipboard.readImage(), encoded);
  assert.deepEqual(closed, ["closed"]);
});

test("terminal clipboard falls back when native image read is empty", async () => {
  const image = new Blob(["browser-image"]);
  const clipboard = createTerminalClipboard(
    {
      read: async () => [
        {
          types: ["image/png"],
          getType: async () => image,
        },
      ],
    },
    async () => ({
      readImage: async () => {
        throw new Error("no native image");
      },
    }),
  );

  assert.equal(await clipboard.readImage(), image);
});

test("terminal clipboard can prefer native text operations", async () => {
  const writes: string[] = [];
  const clipboard = createTerminalClipboard(undefined, async () => ({
    readText: async () => "native text",
    writeText: async (text) => writes.push(text),
  }));

  assert.equal(await clipboard.readText(), "native text");
  await clipboard.writeText("copy");
  assert.deepEqual(writes, ["copy"]);
});

test("terminal clipboard converts blobs to raw base64", async () => {
  assert.equal(await blobToBase64(new Blob(["abc"])), "YWJj");
});

test("terminal clipboard png encoder is unavailable outside a browser DOM", async () => {
  assert.equal(
    await encodeRgbaToPngBlob({
      rgba: new Uint8Array([255, 0, 0, 255]),
      width: 1,
      height: 1,
    }),
    null,
  );
});

test("terminal clipboard normalizes non-png image blobs before saving", async () => {
  const jpeg = new Blob(["jpeg"], { type: "image/jpeg" });
  const unknown = new Blob(["unknown"]);
  const png = new Blob(["png"], { type: "image/png" });
  const converted: Blob[] = [];

  assert.equal(
    await normalizeImageBlobToPng(jpeg, async (input) => {
      assert.equal(input, jpeg);
      converted.push(input);
      return png;
    }),
    png,
  );
  assert.equal(
    await normalizeImageBlobToPng(unknown, async (input) => {
      assert.equal(input, unknown);
      converted.push(input);
      return png;
    }),
    png,
  );
  assert.equal(converted.length, 2);
  assert.equal(converted[0], jpeg);
  assert.equal(converted[1], unknown);
  assert.equal(
    await normalizeImageBlobToPng(png, async () => {
      throw new Error("unexpected conversion");
    }),
    png,
  );
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

  assert.equal(await createTerminalClipboard(clipboardLike, async () => null).readImage(), null);
});
