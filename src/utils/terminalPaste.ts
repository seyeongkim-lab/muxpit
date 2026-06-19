import type { SshConnection } from "./sshConnection.ts";
import { blobToBase64, type TerminalClipboardPort } from "./terminalClipboard.ts";

export interface TerminalPasteSurface {
  paste(text: string): void;
  write(data: string): void;
}

export interface TerminalImageUploader {
  pushImageToRemote(input: {
    sshCommand: string;
    sshConnection: SshConnection | null;
    imageBase64: string;
  }): Promise<string>;
}

export interface TerminalPasteOptions {
  clipboard: TerminalClipboardPort;
  imageUploader: TerminalImageUploader;
  surface: TerminalPasteSurface;
  spawnCommand: string | null;
  spawnSshConnection: SshConnection | null;
  logError?: (...args: unknown[]) => void;
}

export const pasteTerminalClipboard = async ({
  clipboard,
  imageUploader,
  surface,
  spawnCommand,
  spawnSshConnection,
  logError = console.error,
}: TerminalPasteOptions): Promise<void> => {
  const image = spawnCommand ? await clipboard.readImage() : null;
  if (image && spawnCommand) {
    try {
      const remotePath = await imageUploader.pushImageToRemote({
        sshCommand: spawnCommand,
        sshConnection: spawnSshConnection,
        imageBase64: await blobToBase64(image),
      });
      surface.paste(remotePath + " ");
    } catch (err) {
      logError("[wmux] image paste failed:", err);
      surface.write(`\r\n\x1b[31m[image upload failed: ${err}]\x1b[0m\r\n`);
    }
    return;
  }

  const text = await clipboard.readText();
  if (text) surface.paste(text);
};
