import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "./runtime";
import { getSharedWmuxServerClient } from "./wmuxServerClient";

const SERVER_INVOKE_COMMANDS = new Set([
  "check_remote_tmux",
  "check_remote_clis",
  "tmux_list_sessions",
  "tmux_switch_client",
  "tmux_new_session",
  "tmux_kill_session",
  "start_monitor",
  "stop_monitor",
  "request_session_content",
  "get_workspace_info",
  "get_ports",
  "get_pty_pid",
  "get_shell_ctx",
  "get_session_metadata",
  "pty_has_agent_process",
  "save_image_locally",
  "push_image_to_remote",
]);

const BROWSER_NOOP_COMMANDS = new Set([
  "set_workspace_list",
  "send_notification",
]);

export const appInvoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> => {
  if (!isTauriRuntime()) {
    if (SERVER_INVOKE_COMMANDS.has(command)) {
      return getSharedWmuxServerClient().invokeCommand<T>(command, args ?? {});
    }
    if (BROWSER_NOOP_COMMANDS.has(command)) {
      return Promise.resolve(undefined as T);
    }
    return Promise.reject(new Error(`${command} is unavailable in the browser runtime`));
  }
  return tauriInvoke<T>(command, args);
};

export const appListen = <T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> => {
  if (!isTauriRuntime()) {
    return getSharedWmuxServerClient().listenEvent<T>(event, handler);
  }
  return tauriListen<T>(event, (tauriEvent) => handler(tauriEvent.payload));
};

export const openExternalUrl = (uri: string): Promise<void> => {
  if (isTauriRuntime()) {
    return import("@tauri-apps/plugin-shell").then(({ open }) => open(uri));
  }
  window.open(uri, "_blank", "noopener,noreferrer");
  return Promise.resolve();
};
