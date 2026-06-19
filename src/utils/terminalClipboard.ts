export interface ClipboardItemLike {
  types: readonly string[];
  getType(type: string): Promise<Blob>;
}

export interface ClipboardLike {
  read?: () => Promise<ClipboardItemLike[]>;
  readText?: () => Promise<string>;
  writeText?: (text: string) => Promise<void>;
}

export interface NativeClipboardImageLike {
  rgba(): Promise<Uint8Array>;
  size(): Promise<{ width: number; height: number }>;
  close?(): Promise<void>;
}

export interface NativeClipboardLike {
  readImage?: () => Promise<NativeClipboardImageLike>;
  readText?: () => Promise<string>;
  writeText?: (text: string, options?: { label?: string }) => Promise<void>;
}

export type NativeClipboardProvider = () => Promise<NativeClipboardLike | null>;

export type ClipboardImageEncoder = (input: {
  rgba: Uint8Array;
  width: number;
  height: number;
}) => Promise<Blob | null>;

export type ClipboardImageBlobConverter = (blob: Blob) => Promise<Blob>;

export interface TerminalClipboardPort {
  readImage(): Promise<Blob | null>;
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

const currentClipboard = (): ClipboardLike | undefined =>
  typeof navigator === "undefined" ? undefined : navigator.clipboard;

let nativeClipboardPromise: Promise<NativeClipboardLike | null> | undefined;

const currentNativeClipboard = (): Promise<NativeClipboardLike | null> => {
  nativeClipboardPromise ??= import("@tauri-apps/plugin-clipboard-manager")
    .then((plugin) => plugin)
    .catch(() => null);
  return nativeClipboardPromise;
};

export const encodeRgbaToPngBlob: ClipboardImageEncoder = async ({ rgba, width, height }) => {
  if (typeof document === "undefined" || typeof ImageData === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
};

export const convertImageBlobToPng: ClipboardImageBlobConverter = async (blob) => {
  if (
    typeof document === "undefined" ||
    typeof createImageBitmap === "undefined"
  ) {
    throw new Error("image conversion unavailable");
  }

  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("image conversion unavailable");
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("image conversion failed");
    return png;
  } finally {
    bitmap.close?.();
  }
};

export const normalizeImageBlobToPng = async (
  blob: Blob,
  converter: ClipboardImageBlobConverter = convertImageBlobToPng,
): Promise<Blob> => {
  if (blob.type === "image/png") return blob;
  return converter(blob);
};

const readNativeImage = async (
  nativeClipboard: NativeClipboardLike | null,
  imageEncoder: ClipboardImageEncoder,
): Promise<Blob | null> => {
  if (!nativeClipboard?.readImage) return null;
  let image: NativeClipboardImageLike | null = null;
  try {
    image = await nativeClipboard.readImage();
    const [{ width, height }, rgba] = await Promise.all([image.size(), image.rgba()]);
    return await imageEncoder({ rgba, width, height });
  } catch {
    return null;
  } finally {
    try {
      await image?.close?.();
    } catch {
      // Clipboard image resources are best-effort cleanup.
    }
  }
};

export const createTerminalClipboard = (
  clipboard: ClipboardLike | undefined = currentClipboard(),
  nativeClipboardProvider: NativeClipboardProvider = currentNativeClipboard,
  imageEncoder: ClipboardImageEncoder = encodeRgbaToPngBlob,
): TerminalClipboardPort => ({
  readImage: async () => {
    const nativeImage = await readNativeImage(await nativeClipboardProvider(), imageEncoder);
    if (nativeImage) return nativeImage;

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
    const nativeClipboard = await nativeClipboardProvider();
    if (nativeClipboard?.readText) {
      try {
        const text = await nativeClipboard.readText();
        if (text) return text;
      } catch {
        // Browser clipboard fallback below can still work in non-Tauri contexts.
      }
    }

    if (!clipboard?.readText) return "";
    try {
      return await clipboard.readText();
    } catch {
      return "";
    }
  },
  writeText: async (text: string) => {
    const nativeClipboard = await nativeClipboardProvider();
    if (nativeClipboard?.writeText) {
      try {
        await nativeClipboard.writeText(text);
        return;
      } catch {
        // Browser clipboard fallback below can still work in non-Tauri contexts.
      }
    }

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
