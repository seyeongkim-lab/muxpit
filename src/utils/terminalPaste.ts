import type { SshConnection } from "./sshConnection.ts";
import { parseSshCommandLine, quotePosixShellArg } from "./sshConnection.ts";
import { getRuntimePlatform, type RuntimePlatform } from "./runtimePlatform.ts";
import {
  blobToBase64,
  normalizeImageBlobToPng,
  type TerminalClipboardPort,
} from "./terminalClipboard.ts";

export interface TerminalPasteSurface {
  paste(text: string): void;
  write(data: string): void;
}

export interface TerminalImageStore {
  saveImageLocally(input: {
    imageBase64: string;
  }): Promise<string>;
  pushImageToRemote(input: {
    sshCommand: string;
    sshConnection: SshConnection | null;
    imageBase64: string;
  }): Promise<string>;
}

export interface TerminalRemotePasteTarget {
  spawnCommand: string | null;
  spawnSshConnection: SshConnection | null;
}

export interface TerminalPasteOptions {
  clipboard: TerminalClipboardPort;
  imageStore: TerminalImageStore;
  surface: TerminalPasteSurface;
  spawnCommand: string | null;
  spawnSshConnection: SshConnection | null;
  platform?: RuntimePlatform;
  logError?: (...args: unknown[]) => void;
}

export interface TerminalPasteEventLike {
  getImage(): Blob | null;
  getText(): string;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface TerminalPasteEventOptions extends TerminalPasteOptions {
  event: TerminalPasteEventLike;
}

export interface PasteClipboardItemLike {
  type: string;
  getAsFile(): Blob | null;
}

export interface PasteClipboardDataLike {
  items: ArrayLike<PasteClipboardItemLike>;
  getData?: (format: string) => string;
}

const quoteWindowsShellArg = (value: string): string =>
  `"${value.replace(/"/g, '""')}"`;

export const getPastedImage = (
  clipboardData: PasteClipboardDataLike | null | undefined,
): Blob | null => {
  if (!clipboardData) return null;
  for (let index = 0; index < clipboardData.items.length; index += 1) {
    const item = clipboardData.items[index];
    if (item.type.startsWith("image/")) return item.getAsFile();
  }
  return null;
};

export const getPastedText = (
  clipboardData: PasteClipboardDataLike | null | undefined,
): string => {
  if (!clipboardData?.getData) return "";
  try {
    return clipboardData.getData("text/plain") || clipboardData.getData("text") || "";
  } catch {
    return "";
  }
};

export const isTerminalRemotePasteTarget = ({
  spawnCommand,
  spawnSshConnection,
}: TerminalRemotePasteTarget): boolean =>
  !!spawnCommand && (!!spawnSshConnection || !!parseSshCommandLine(spawnCommand));

export type TerminalImagePasteTarget =
  | {
      kind: "remote";
      sshCommand: string;
      sshConnection: SshConnection | null;
    }
  | { kind: "local" };

export const resolveTerminalImagePasteTarget = ({
  spawnCommand,
  spawnSshConnection,
}: TerminalRemotePasteTarget): TerminalImagePasteTarget => {
  if (isTerminalRemotePasteTarget({ spawnCommand, spawnSshConnection })) {
    return {
      kind: "remote",
      sshCommand: spawnCommand as string,
      sshConnection: spawnSshConnection,
    };
  }
  return { kind: "local" };
};

export const formatPastedImagePath = (
  path: string,
  target: TerminalImagePasteTarget,
  platform: RuntimePlatform = getRuntimePlatform(),
): string => {
  if (target.kind === "remote") return quotePosixShellArg(path);
  return platform === "windows" ? quoteWindowsShellArg(path) : quotePosixShellArg(path);
};

export const pasteTerminalImage = async ({
  image,
  imageStore,
  surface,
  spawnCommand,
  spawnSshConnection,
  platform = getRuntimePlatform(),
  logError = console.error,
}: Omit<TerminalPasteOptions, "clipboard"> & { image: Blob }): Promise<void> => {
  try {
    const imageBase64 = await blobToBase64(await normalizeImageBlobToPng(image));
    const target = resolveTerminalImagePasteTarget({ spawnCommand, spawnSshConnection });
    const path = target.kind === "remote"
      ? await imageStore.pushImageToRemote({
          sshCommand: target.sshCommand,
          sshConnection: target.sshConnection,
          imageBase64,
        })
      : await imageStore.saveImageLocally({ imageBase64 });
    surface.paste(formatPastedImagePath(path, target, platform) + " ");
  } catch (err) {
    logError("[muxpit] image paste failed:", err);
    surface.write(`\r\n\x1b[31m[image paste failed: ${err}]\x1b[0m\r\n`);
  }
};

export const pasteTerminalClipboard = async ({
  clipboard,
  imageStore,
  surface,
  spawnCommand,
  spawnSshConnection,
  platform = getRuntimePlatform(),
  logError = console.error,
}: TerminalPasteOptions): Promise<void> => {
  const text = await clipboard.readText().catch(() => "");
  if (text) {
    surface.paste(text);
    return;
  }

  const image = await clipboard.readImage();
  if (image) {
    await pasteTerminalImage({
      image,
      imageStore,
      surface,
      spawnCommand,
      spawnSshConnection,
      platform,
      logError,
    });
    return;
  }
};

export const pasteTerminalPasteEvent = async ({
  event,
  clipboard,
  imageStore,
  surface,
  spawnCommand,
  spawnSshConnection,
  platform = getRuntimePlatform(),
  logError = console.error,
}: TerminalPasteEventOptions): Promise<boolean> => {
  event.preventDefault();
  event.stopPropagation();

  const text = event.getText();
  if (text) {
    surface.paste(text);
    return true;
  }

  const image = event.getImage();
  if (image) {
    await pasteTerminalImage({
      image,
      imageStore,
      surface,
      spawnCommand,
      spawnSshConnection,
      platform,
      logError,
    });
    return true;
  }

  await pasteTerminalClipboard({
    clipboard,
    imageStore,
    surface,
    spawnCommand,
    spawnSshConnection,
    platform,
    logError,
  });
  return true;
};
