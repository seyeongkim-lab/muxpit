export interface ClipboardItemLike {
  types: readonly string[];
  getType(type: string): Promise<Blob>;
}

export interface ClipboardLike {
  read?: () => Promise<ClipboardItemLike[]>;
  readText?: () => Promise<string>;
  writeText?: (text: string) => Promise<void>;
}

export interface TerminalClipboardPort {
  readImage(): Promise<Blob | null>;
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

const currentClipboard = (): ClipboardLike | undefined =>
  typeof navigator === "undefined" ? undefined : navigator.clipboard;

export const createTerminalClipboard = (
  clipboard: ClipboardLike | undefined = currentClipboard(),
): TerminalClipboardPort => ({
  readImage: async () => {
    if (!clipboard?.read) return null;
    try {
      for (const item of await clipboard.read()) {
        const type = item.types.find((candidate) => candidate.startsWith("image/"));
        if (type) return await item.getType(type);
      }
    } catch {
      // Denied or unsupported image clipboard access should fall back to text.
    }
    return null;
  },
  readText: async () => {
    if (!clipboard?.readText) return "";
    try {
      return await clipboard.readText();
    } catch {
      return "";
    }
  },
  writeText: async (text: string) => {
    if (!clipboard?.writeText) return;
    try {
      await clipboard.writeText(text);
    } catch {
      // Clipboard writes are best-effort; keep terminal input handling quiet.
    }
  },
});

export const blobToBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};
