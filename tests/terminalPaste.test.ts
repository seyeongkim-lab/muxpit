import test from "node:test";
import assert from "node:assert/strict";

import { pasteTerminalClipboard } from "../src/utils/terminalPaste.ts";
import type { TerminalClipboardPort } from "../src/utils/terminalClipboard.ts";

const createSurface = () => {
  const pasted: string[] = [];
  const written: string[] = [];
  return {
    pasted,
    written,
    surface: {
      paste: (text: string) => pasted.push(text),
      write: (data: string) => written.push(data),
    },
  };
};

test("terminal paste reads plain text for local panes", async () => {
  const { pasted, surface } = createSurface();
  let imageRead = false;
  const clipboard: TerminalClipboardPort = {
    readImage: async () => {
      imageRead = true;
      return null;
    },
    readText: async () => "hello",
    writeText: async () => {},
  };

  await pasteTerminalClipboard({
    clipboard,
    imageUploader: {
      pushImageToRemote: async () => {
        throw new Error("unexpected upload");
      },
    },
    surface,
    spawnCommand: null,
    spawnSshConnection: null,
  });

  assert.equal(imageRead, false);
  assert.deepEqual(pasted, ["hello"]);
});

test("terminal paste uploads clipboard images for spawned SSH panes", async () => {
  const { pasted, surface } = createSurface();
  const image = new Blob(["image"]);
  const clipboard: TerminalClipboardPort = {
    readImage: async () => image,
    readText: async () => {
      throw new Error("unexpected text fallback");
    },
    writeText: async () => {},
  };

  await pasteTerminalClipboard({
    clipboard,
    imageUploader: {
      pushImageToRemote: async ({ sshCommand, imageBase64 }) => {
        assert.equal(sshCommand, "ssh host");
        assert.equal(imageBase64, "aW1hZ2U=");
        return "/tmp/wmux-image.png";
      },
    },
    surface,
    spawnCommand: "ssh host",
    spawnSshConnection: null,
  });

  assert.deepEqual(pasted, ["/tmp/wmux-image.png "]);
});

test("terminal paste reports image upload failures without falling through to text", async () => {
  const { pasted, written, surface } = createSurface();
  const logs: unknown[][] = [];
  const clipboard: TerminalClipboardPort = {
    readImage: async () => new Blob(["image"]),
    readText: async () => {
      throw new Error("unexpected text fallback");
    },
    writeText: async () => {},
  };

  await pasteTerminalClipboard({
    clipboard,
    imageUploader: {
      pushImageToRemote: async () => {
        throw new Error("upload failed");
      },
    },
    surface,
    spawnCommand: "ssh host",
    spawnSshConnection: null,
    logError: (...args) => logs.push(args),
  });

  assert.deepEqual(pasted, []);
  assert.equal(logs.length, 1);
  assert.match(written[0], /image upload failed/);
});
