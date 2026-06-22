import type {
  PtyBackend,
  PtyExit,
  PtyOutput,
  ShellContext,
  SpawnPtyRequest,
  SpawnTmuxCcRequest,
} from "./ptyBackend";
import { getServerToken, getSharedWmuxServerClient } from "./wmuxServerClient";

export const browserPtyBackend: PtyBackend = {
  onOutput: async (handler: (payload: PtyOutput) => void) => {
    const client = getSharedWmuxServerClient();
    return client.onOutput((payload) => {
      handler({ id: payload.ptyId, data: payload.data });
    });
  },
  onExit: async (handler: (payload: PtyExit) => void) => {
    const client = getSharedWmuxServerClient();
    return client.onExit((payload) => {
      handler({ id: payload.ptyId, code: payload.code });
    });
  },
  spawn: (request: SpawnPtyRequest) =>
    getSharedWmuxServerClient().spawnTerminal({
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
    getSharedWmuxServerClient().spawnTerminal({
      rows: request.rows,
      cols: request.cols,
      command: request.sshCommand,
      commandArgv: null,
      sshConnection: request.sshConnection,
      tmuxSession: request.sessionName,
      cwd: null,
      enableCwdReporting: false,
      enableAgentSessionReporting: false,
      workspaceId: request.workspaceId,
      surfaceId: request.surfaceId,
    }),
  write: (id, data) => getSharedWmuxServerClient().writePty(id, data),
  resize: (id, rows, cols) => getSharedWmuxServerClient().resizePty(id, rows, cols),
  kill: (id) => getSharedWmuxServerClient().killPty(id),
  getShellContext: (id): Promise<ShellContext> =>
    getSharedWmuxServerClient().invokeCommand<ShellContext>("get_shell_ctx", { id }),
  hasAgentProcess: (id, agent) =>
    getSharedWmuxServerClient().invokeCommand<boolean>("pty_has_agent_process", { id, agent }),
  saveImageLocally: (request) =>
    getSharedWmuxServerClient().invokeCommand<string>("save_image_locally", {
      imageBase64: request.imageBase64,
    }),
  pushImageToRemote: (request) =>
    getSharedWmuxServerClient().invokeCommand<string>("push_image_to_remote", {
      sshCommand: request.sshCommand,
      sshConnection: request.sshConnection,
      imageBase64: request.imageBase64,
    }),
};

export const hasBrowserPtyToken = (): boolean => getServerToken().trim() !== "";
