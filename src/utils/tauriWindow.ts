import { getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";
import { getCurrentWebview, type Webview } from "@tauri-apps/api/webview";

type TauriMetadataHost = {
  __TAURI_INTERNALS__?: {
    metadata?: {
      currentWindow?: {
        label?: unknown;
      };
      currentWebview?: {
        label?: unknown;
      };
    };
  };
};

const currentGlobalWindow = (): unknown =>
  typeof window === "undefined" ? undefined : window;

export const hasTauriCurrentWindow = (host: unknown = currentGlobalWindow()): boolean => {
  const label = (host as TauriMetadataHost | undefined)?.__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
  return typeof label === "string" && label.length > 0;
};

export const hasTauriCurrentWebview = (host: unknown = currentGlobalWindow()): boolean => {
  const label = (host as TauriMetadataHost | undefined)?.__TAURI_INTERNALS__?.metadata?.currentWebview?.label;
  return typeof label === "string" && label.length > 0;
};

export const tryGetCurrentWindow = (): TauriWindow | null =>
  hasTauriCurrentWindow() ? getCurrentWindow() : null;

export const tryGetCurrentWebview = (): Webview | null =>
  hasTauriCurrentWebview() ? getCurrentWebview() : null;
