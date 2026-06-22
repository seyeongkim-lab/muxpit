import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./runtime";

export const appInvoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> => {
  if (!isTauriRuntime()) {
    return Promise.reject(new Error(`${command} is unavailable in the browser runtime`));
  }
  return tauriInvoke<T>(command, args);
};

export const appListen = <T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> => {
  if (!isTauriRuntime()) return Promise.resolve(() => {});
  return tauriListen<T>(event, (tauriEvent) => handler(tauriEvent.payload));
};

export const openExternalUrl = (uri: string): Promise<void> => {
  if (isTauriRuntime()) {
    return import("@tauri-apps/plugin-shell").then(({ open }) => open(uri));
  }
  window.open(uri, "_blank", "noopener,noreferrer");
  return Promise.resolve();
};

