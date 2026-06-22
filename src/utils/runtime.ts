type TauriRuntimeHost = {
  __TAURI_INTERNALS__?: unknown;
};

export const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" &&
  typeof (window as TauriRuntimeHost).__TAURI_INTERNALS__ === "object";

export const isWmuxServerRuntime = (): boolean =>
  typeof window !== "undefined" && !isTauriRuntime();

