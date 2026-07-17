import { blobToBase64, normalizeImageBlobToPng } from "../utils/terminalClipboard.ts";

export interface AgentImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  data: string;
  size: number;
}

interface ClipboardItemLike {
  kind: string;
  type: string;
  getAsFile(): Blob | null;
}

interface ClipboardDataLike {
  items: ArrayLike<ClipboardItemLike>;
}

const MAX_IMAGES = 4;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const imageId = (): string => {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `image-${suffix}`;
};

const imageName = (blob: Blob, index: number): string => {
  const named = blob as Blob & { name?: string };
  return named.name || `image-${index + 1}.${blob.type === "image/jpeg" ? "jpg" : "png"}`;
};

export const imageBlobsFromClipboard = (data: ClipboardDataLike): Blob[] =>
  Array.from(data.items).flatMap((item) => {
    if (item.kind !== "file" || !item.type.startsWith("image/")) return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });

export const createAgentImageAttachments = async (
  blobs: readonly Blob[],
  current: readonly AgentImageAttachment[] = [],
): Promise<AgentImageAttachment[]> => {
  if (current.length + blobs.length > MAX_IMAGES) {
    throw new Error(`Attach up to ${MAX_IMAGES} images.`);
  }

  const normalized = await Promise.all(blobs.map(async (blob) => {
    if (!blob.type.startsWith("image/")) throw new Error("Only image files can be attached.");
    return SUPPORTED_IMAGE_TYPES.has(blob.type)
      ? blob
      : normalizeImageBlobToPng(blob);
  }));
  const totalBytes = current.reduce((sum, attachment) => sum + attachment.size, 0)
    + normalized.reduce((sum, blob) => sum + blob.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Image attachments are limited to 8 MB total.");

  return Promise.all(normalized.map(async (blob, index) => ({
    id: imageId(),
    name: imageName(blobs[index], current.length + index),
    mimeType: blob.type || "image/png",
    data: await blobToBase64(blob),
    size: blob.size,
  })));
};

export const agentImageDataUrl = (attachment: AgentImageAttachment): string =>
  `data:${attachment.mimeType};base64,${attachment.data}`;

export const codexPromptInput = (
  text: string,
  attachments: readonly AgentImageAttachment[] = [],
): Record<string, unknown>[] => [
  ...(text.trim() ? [{ type: "text", text: text.trim(), text_elements: [] }] : []),
  ...attachments.map((attachment) => ({
    type: "image",
    url: agentImageDataUrl(attachment),
    detail: "auto",
  })),
];

export const claudePromptLine = (
  text: string,
  attachments: readonly AgentImageAttachment[] = [],
): string => JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [
      ...(text.trim() ? [{ type: "text", text: text.trim() }] : []),
      ...attachments.map((attachment) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mimeType,
          data: attachment.data,
        },
      })),
    ],
  },
  parent_tool_use_id: null,
});

export const acpPromptBlocks = (
  text: string,
  attachments: readonly AgentImageAttachment[] = [],
): Record<string, unknown>[] => [
  ...(text.trim() ? [{ type: "text", text: text.trim() }] : []),
  ...attachments.map((attachment) => ({
    type: "image",
    mimeType: attachment.mimeType,
    data: attachment.data,
  })),
];

export const promptTimelineText = (
  text: string,
  attachments: readonly AgentImageAttachment[] = [],
): string => {
  const trimmed = text.trim();
  if (attachments.length === 0) return trimmed;
  const label = `[${attachments.length} image${attachments.length === 1 ? "" : "s"}]`;
  return trimmed ? `${trimmed}\n\n${label}` : label;
};
