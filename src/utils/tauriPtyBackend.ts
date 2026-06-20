import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  PtyBackend,
  PtyExit,
  PtyOutput,
  PushImageToRemoteRequest,
  SaveImageLocallyRequest,
  ShellContext,
  SpawnPtyRequest,
  SpawnTmuxCcRequest,
} from "./ptyBackend";

export const tauriPtyBackend: PtyBackend = {
  onOutput: (handler) => listen<PtyOutput>("pty-output", (event) => handler(event.payload)),
  onExit: (handler) => listen<PtyExit>("pty-exit", (event) => handler(event.payload)),
  spawn: (request: SpawnPtyRequest) =>
    invoke<number>("spawn_pty", {
      rows: request.rows,
      cols: request.cols,
      command: request.command,
      commandArgv: request.commandArgv,
      cwd: request.cwd,
      enableCwdReporting: request.enableCwdReporting,
      workspaceId: request.workspaceId,
      surfaceId: request.surfaceId,
    }),
  spawnTmuxCc: (request: SpawnTmuxCcRequest) =>
    invoke<number>("spawn_pty_tmux_cc", {
      rows: request.rows,
      cols: request.cols,
      sshCommand: request.sshCommand,
      sshConnection: request.sshConnection,
      sessionName: request.sessionName,
      workspaceId: request.workspaceId,
      surfaceId: request.surfaceId,
    }),
  write: (id, data) => invoke("write_pty", { id, data }),
  resize: (id, rows, cols) => invoke("resize_pty", { id, rows, cols }),
  kill: (id) => invoke("kill_pty", { id }),
  getShellContext: (id) => invoke<ShellContext>("get_shell_ctx", { id }),
  saveImageLocally: (request: SaveImageLocallyRequest) =>
    invoke<string>("save_image_locally", {
      imageBase64: request.imageBase64,
    }),
  pushImageToRemote: (request: PushImageToRemoteRequest) =>
    invoke<string>("push_image_to_remote", {
      sshCommand: request.sshCommand,
      sshConnection: request.sshConnection,
      imageBase64: request.imageBase64,
    }),
};
