import test from "node:test";
import assert from "node:assert/strict";

import {
  formatPastedImagePath,
  getPastedImage,
  getPastedText,
  isTerminalRemotePasteTarget,
  pasteTerminalClipboard,
  pasteTerminalPasteEvent,
  pasteTerminalImage,
  resolveTerminalImagePasteTarget,
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

const createPngBlob = (data: string): Blob => new Blob([data], { type: "image/png" });

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
    imageStore: {
      saveImageLocally: async () => {
        throw new Error("unexpected local save");
      },
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

test("terminal paste prefers text when the clipboard also has an image", async () => {
  const { pasted, surface } = createSurface();
  let imageRead = false;
  const clipboard: TerminalClipboardPort = {
    readText: async () => "copied text",
    readImage: async () => {
      imageRead = true;
      return createPngBlob("image");
    },
    writeText: async () => {},
  };

  await pasteTerminalClipboard({
    clipboard,
    imageStore: {
      saveImageLocally: async () => {
        throw new Error("unexpected local save");
      },
      pushImageToRemote: async () => {
        throw new Error("unexpected upload");
      },
    },
    surface,
    spawnCommand: "ssh host",
    spawnSshConnection: null,
  });

  assert.equal(imageRead, false);
  assert.deepEqual(pasted, ["copied text"]);
});

test("terminal paste uploads clipboard images for spawned SSH panes", async () => {
  const { pasted, surface } = createSurface();
  const image = createPngBlob("image");
  const clipboard: TerminalClipboardPort = {
    readImage: async () => image,
    readText: async () => {
      throw new Error("unexpected text fallback");
    },
    writeText: async () => {},
  };

  await pasteTerminalClipboard({
    clipboard,
    imageStore: {
      saveImageLocally: async () => {
        throw new Error("unexpected local save");
      },
      pushImageToRemote: async ({ sshCommand, imageBase64 }) => {
        assert.equal(sshCommand, "ssh host");
        assert.equal(imageBase64, "aW1hZ2U=");
        return "/tmp/muxpit-image.png";
      },
    },
    surface,
    spawnCommand: "ssh host",
    spawnSshConnection: null,
  });

  assert.deepEqual(pasted, ["/tmp/muxpit-image.png "]);
});

test("terminal image paste quotes Windows local paths", async () => {
  const { pasted, surface } = createSurface();

  await pasteTerminalImage({
    image: createPngBlob("local-image"),
    imageStore: {
      saveImageLocally: async () => String.raw`C:\Users\Jane Doe\.muxpit\screenshots\local.png`,
      pushImageToRemote: async () => {
        throw new Error("unexpected upload");
      },
    },
    surface,
    spawnCommand: null,
    spawnSshConnection: null,
    platform: "windows",
  });

  assert.deepEqual(pasted, [String.raw`"C:\Users\Jane Doe\.muxpit\screenshots\local.png" `]);
});

test("terminal paste saves clipboard images for local panes", async () => {
  const { pasted, surface } = createSurface();
  const image = createPngBlob("local-image");
  const clipboard: TerminalClipboardPort = {
    readImage: async () => image,
    readText: async () => {
      throw new Error("unexpected text fallback");
    },
    writeText: async () => {},
  };

  await pasteTerminalClipboard({
    clipboard,
    imageStore: {
      saveImageLocally: async ({ imageBase64 }) => {
        assert.equal(imageBase64, "bG9jYWwtaW1hZ2U=");
        return "/home/me/.muxpit/screenshots/local.png";
      },
      pushImageToRemote: async () => {
        throw new Error("unexpected upload");
      },
    },
    surface,
    spawnCommand: null,
    spawnSshConnection: null,
    platform: "linux",
  });

  assert.deepEqual(pasted, ["/home/me/.muxpit/screenshots/local.png "]);
});

test("terminal paste uploads an image supplied by a native paste event", async () => {
  const { pasted, surface } = createSurface();
  const image = createPngBlob("native-image");

  await pasteTerminalImage({
    image,
    imageStore: {
      saveImageLocally: async () => {
        throw new Error("unexpected local save");
      },
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
    readImage: async () => createPngBlob("native-clipboard-image"),
    readText: async () => {
      throw new Error("unexpected text fallback");
    },
    writeText: async () => {},
  };

  const handled = await pasteTerminalPasteEvent({
    event: {
      getImage: () => null,
      getText: () => "",
      preventDefault: () => calls.push("preventDefault"),
      stopPropagation: () => calls.push("stopPropagation"),
    },
    clipboard,
    imageStore: {
      saveImageLocally: async () => {
        throw new Error("unexpected local save");
      },
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

test("terminal paste event prefers event text over event and clipboard images", async () => {
  const { pasted, surface } = createSurface();
  const calls: string[] = [];
  const clipboard: TerminalClipboardPort = {
    readImage: async () => {
      throw new Error("unexpected clipboard image read");
    },
    readText: async () => {
      throw new Error("unexpected clipboard text read");
    },
    writeText: async () => {},
  };

  const handled = await pasteTerminalPasteEvent({
    event: {
      getImage: () => createPngBlob("image"),
      getText: () => "primary selection",
      preventDefault: () => calls.push("preventDefault"),
      stopPropagation: () => calls.push("stopPropagation"),
    },
    clipboard,
    imageStore: {
      saveImageLocally: async () => {
        throw new Error("unexpected local save");
      },
      pushImageToRemote: async () => {
        throw new Error("unexpected upload");
      },
    },
    surface,
    spawnCommand: "ssh host",
    spawnSshConnection: null,
  });

  assert.equal(handled, true);
  assert.deepEqual(calls, ["preventDefault", "stopPropagation"]);
  assert.deepEqual(pasted, ["primary selection"]);
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
      getText: () => "",
      preventDefault: () => {},
      stopPropagation: () => {},
    },
    clipboard,
    imageStore: {
      saveImageLocally: async () => {
        throw new Error("unexpected local save");
      },
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

test("terminal paste event saves native clipboard images for local panes", async () => {
  const { pasted, surface } = createSurface();
  const calls: string[] = [];
  const clipboard: TerminalClipboardPort = {
    readImage: async () => createPngBlob("local-event-image"),
    readText: async () => {
      throw new Error("unexpected text read");
    },
    writeText: async () => {},
  };

  const handled = await pasteTerminalPasteEvent({
    event: {
      getImage: () => createPngBlob("image"),
      getText: () => "",
      preventDefault: () => calls.push("preventDefault"),
      stopPropagation: () => calls.push("stopPropagation"),
    },
    clipboard,
    imageStore: {
      saveImageLocally: async ({ imageBase64 }) => {
        assert.equal(imageBase64, "aW1hZ2U=");
        return "/home/me/.muxpit/screenshots/event.png";
      },
      pushImageToRemote: async () => {
        throw new Error("unexpected upload");
      },
    },
    surface,
    spawnCommand: null,
    spawnSshConnection: null,
    platform: "linux",
  });

  assert.equal(handled, true);
  assert.deepEqual(calls, ["preventDefault", "stopPropagation"]);
  assert.deepEqual(pasted, ["/home/me/.muxpit/screenshots/event.png "]);
});

test("terminal paste event falls back to text for local panes without images", async () => {
  const { pasted, surface } = createSurface();
  const clipboard: TerminalClipboardPort = {
    readImage: async () => null,
    readText: async () => "local text",
    writeText: async () => {},
  };

  const handled = await pasteTerminalPasteEvent({
    event: {
      getImage: () => null,
      getText: () => "",
      preventDefault: () => {},
      stopPropagation: () => {},
    },
    clipboard,
    imageStore: {
      saveImageLocally: async () => {
        throw new Error("unexpected local save");
      },
      pushImageToRemote: async () => {
        throw new Error("unexpected upload");
      },
    },
    surface,
    spawnCommand: null,
    spawnSshConnection: null,
  });

  assert.equal(handled, true);
  assert.deepEqual(pasted, ["local text"]);
});

test("terminal paste reports image upload failures without falling through to text", async () => {
  const { pasted, written, surface } = createSurface();
  const logs: unknown[][] = [];
  const clipboard: TerminalClipboardPort = {
    readImage: async () => createPngBlob("image"),
    readText: async () => {
      throw new Error("unexpected text fallback");
    },
    writeText: async () => {},
  };

  await pasteTerminalClipboard({
    clipboard,
    imageStore: {
      saveImageLocally: async () => {
        throw new Error("unexpected local save");
      },
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
  assert.match(written[0], /image paste failed/);
});

test("terminal paste detects image data from native paste clipboard items", () => {
  const image = createPngBlob("image");
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

test("terminal paste reads text directly from native paste clipboard data", () => {
  assert.equal(
    getPastedText({
      items: [],
      getData: (format) => format === "text/plain" ? "primary text" : "",
    }),
    "primary text",
  );
  assert.equal(
    getPastedText({
      items: [],
      getData: (format) => format === "text" ? "legacy text" : "",
    }),
    "legacy text",
  );
  assert.equal(getPastedText(null), "");
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

test("terminal paste target resolves local and remote image destinations", () => {
  assert.deepEqual(
    resolveTerminalImagePasteTarget({
      spawnCommand: null,
      spawnSshConnection: null,
    }),
    { kind: "local" },
  );
  assert.deepEqual(
    resolveTerminalImagePasteTarget({
      spawnCommand: "bash",
      spawnSshConnection: null,
    }),
    { kind: "local" },
  );
  assert.deepEqual(
    resolveTerminalImagePasteTarget({
      spawnCommand: "ssh host",
      spawnSshConnection: null,
    }),
    {
      kind: "remote",
      sshCommand: "ssh host",
      sshConnection: null,
    },
  );
});

test("terminal paste formats image paths for the target shell", () => {
  assert.equal(
    formatPastedImagePath(String.raw`C:\Users\Jane Doe\.muxpit\screenshots\img.png`, { kind: "local" }, "windows"),
    String.raw`"C:\Users\Jane Doe\.muxpit\screenshots\img.png"`,
  );
  assert.equal(
    formatPastedImagePath("/Users/Jane Doe/.muxpit/screenshots/img.png", { kind: "local" }, "macos"),
    "'/Users/Jane Doe/.muxpit/screenshots/img.png'",
  );
  assert.equal(
    formatPastedImagePath("/home/Jane Doe/.muxpit/screenshots/img.png", {
      kind: "remote",
      sshCommand: "ssh host",
      sshConnection: null,
    }),
    "'/home/Jane Doe/.muxpit/screenshots/img.png'",
  );
});
