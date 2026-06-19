import test from "node:test";
import assert from "node:assert/strict";

import {
  getPastedImage,
  isTerminalRemotePasteTarget,
  pasteTerminalClipboard,
  pasteTerminalPasteEvent,
  pasteTerminalImage,
} from "../src/utils/terminalPaste.ts";
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

test("terminal paste uploads an image supplied by a native paste event", async () => {
  const { pasted, surface } = createSurface();
  const image = new Blob(["native-image"]);

  await pasteTerminalImage({
    image,
    imageUploader: {
      pushImageToRemote: async ({ imageBase64 }) => {
        assert.equal(imageBase64, "bmF0aXZlLWltYWdl");
        return "/tmp/native-image.png";
      },
    },
    surface,
    spawnCommand: "ssh host",
    spawnSshConnection: null,
  });

  assert.deepEqual(pasted, ["/tmp/native-image.png "]);
});

test("terminal paste event falls back to native clipboard image reads for remote panes", async () => {
  const { pasted, surface } = createSurface();
  const calls: string[] = [];
  const clipboard: TerminalClipboardPort = {
    readImage: async () => new Blob(["native-clipboard-image"]),
    readText: async () => {
      throw new Error("unexpected text fallback");
    },
    writeText: async () => {},
  };

  const handled = await pasteTerminalPasteEvent({
    event: {
      getImage: () => null,
      preventDefault: () => calls.push("preventDefault"),
      stopPropagation: () => calls.push("stopPropagation"),
    },
    clipboard,
    imageUploader: {
      pushImageToRemote: async ({ imageBase64 }) => {
        assert.equal(imageBase64, "bmF0aXZlLWNsaXBib2FyZC1pbWFnZQ==");
        return "/tmp/clipboard-image.png";
      },
    },
    surface,
    spawnCommand: "ssh host",
    spawnSshConnection: null,
  });

  assert.equal(handled, true);
  assert.deepEqual(calls, ["preventDefault", "stopPropagation"]);
  assert.deepEqual(pasted, ["/tmp/clipboard-image.png "]);
});

test("terminal paste event falls back to text for remote panes without images", async () => {
  const { pasted, surface } = createSurface();
  const clipboard: TerminalClipboardPort = {
    readImage: async () => null,
    readText: async () => "hello",
    writeText: async () => {},
  };

  const handled = await pasteTerminalPasteEvent({
    event: {
      getImage: () => null,
      preventDefault: () => {},
      stopPropagation: () => {},
    },
    clipboard,
    imageUploader: {
      pushImageToRemote: async () => {
        throw new Error("unexpected upload");
      },
    },
    surface,
    spawnCommand: "ssh host",
    spawnSshConnection: null,
  });

  assert.equal(handled, true);
  assert.deepEqual(pasted, ["hello"]);
});

test("terminal paste event leaves local panes to xterm", async () => {
  const { pasted, surface } = createSurface();
  const calls: string[] = [];
  const clipboard: TerminalClipboardPort = {
    readImage: async () => {
      throw new Error("unexpected image read");
    },
    readText: async () => {
      throw new Error("unexpected text read");
    },
    writeText: async () => {},
  };

  const handled = await pasteTerminalPasteEvent({
    event: {
      getImage: () => new Blob(["image"]),
      preventDefault: () => calls.push("preventDefault"),
      stopPropagation: () => calls.push("stopPropagation"),
    },
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

  assert.equal(handled, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(pasted, []);
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

test("terminal paste detects image data from native paste clipboard items", () => {
  const image = new Blob(["image"]);
  const textItem = {
    type: "text/plain",
    getAsFile: () => {
      throw new Error("unexpected text file read");
    },
  };
  const imageItem = {
    type: "image/png",
    getAsFile: () => image,
  };

  assert.equal(getPastedImage({ items: [textItem, imageItem] }), image);
  assert.equal(getPastedImage({ items: [textItem] }), null);
  assert.equal(getPastedImage(null), null);
});

test("terminal paste marks only SSH panes as remote image paste targets", () => {
  assert.equal(
    isTerminalRemotePasteTarget({
      spawnCommand: "ssh host",
      spawnSshConnection: null,
    }),
    true,
  );
  assert.equal(
    isTerminalRemotePasteTarget({
      spawnCommand: "bash",
      spawnSshConnection: null,
    }),
    false,
  );
  assert.equal(
    isTerminalRemotePasteTarget({
      spawnCommand: null,
      spawnSshConnection: {
        program: "ssh",
        options: [],
        target: "host",
      },
    }),
    false,
  );
  assert.equal(
    isTerminalRemotePasteTarget({
      spawnCommand: "ssh host",
      spawnSshConnection: {
        program: "ssh",
        options: [],
        target: "host",
      },
    }),
    true,
  );
});
