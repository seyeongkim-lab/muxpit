import { Channel, invoke } from "@tauri-apps/api/core";
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

// PTY events arrive over a single ipc Channel instead of broadcast Tauri
// events: the renderer buffers broadcast events natively faster than it
// consumes them under sustained multi-pane output, growing until the WebView2
// renderer hits Out of Memory (verification.md 2026-07-08).
type PtyEventMessage =
  | { event: "output"; data: PtyOutput }
  | { event: "exit"; data: PtyExit };

const outputHandlers = new Set<(payload: PtyOutput) => void>();
const exitHandlers = new Set<(payload: PtyExit) => void>();
let subscription: Promise<void> | null = null;

const ensureSubscribed = (): Promise<void> => {
  if (!subscription) {
    const channel = new Channel<PtyEventMessage>();
    channel.onmessage = (message) => {
      if (message.event === "output") {
        for (const handler of outputHandlers) handler(message.data);
      } else {
        for (const handler of exitHandlers) handler(message.data);
      }
    };
    subscription = invoke("subscribe_pty_events", { channel });
  }
  return subscription;
};

export const tauriPtyBackend: PtyBackend = {
  onOutput: async (handler) => {
    outputHandlers.add(handler);
    await ensureSubscribed();
    return () => outputHandlers.delete(handler);
  },
  onExit: async (handler) => {
    exitHandlers.add(handler);
    await ensureSubscribed();
    return () => exitHandlers.delete(handler);
  },
  spawn: (request: SpawnPtyRequest) =>
    invoke<number>("spawn_pty", {
      rows: request.rows,
      cols: request.cols,
      command: request.command,
      commandArgv: request.commandArgv,
      cwd: request.cwd,
      enableCwdReporting: request.enableCwdReporting,
      enableAgentSessionReporting: request.enableAgentSessionReporting,
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
  hasAgentProcess: (id, agent) => invoke<boolean>("pty_has_agent_process", { id, agent }),
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
