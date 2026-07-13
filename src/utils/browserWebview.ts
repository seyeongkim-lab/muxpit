export const browserWebviewLabel = (surfaceId: string): string =>
  `wmux-browser-${surfaceId.replace(/[^a-zA-Z0-9:_-]+/g, "-")}`;

export const normalizeBrowserUrl = (value: string): string => {
  const trimmed = value.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser URL must use http or https");
  }
  return url.toString();
};
