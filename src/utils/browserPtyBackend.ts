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
import { getServerToken, getSharedWmuxServerClient } from "./wmuxServerClient";

const unavailable = (feature: string): Promise<never> =>
  Promise.reject(new Error(`${feature} is not implemented by wmux-server yet`));

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
      workspaceId: request.workspaceId,
      surfaceId: request.surfaceId,
    }),
  write: (id, data) => getSharedWmuxServerClient().writePty(id, data),
  resize: (id, rows, cols) => getSharedWmuxServerClient().resizePty(id, rows, cols),
  kill: (id) => getSharedWmuxServerClient().killPty(id),
  getShellContext: (_id): Promise<ShellContext> =>
    Promise.resolve({ ssh_command: null, cwd: null }),
  hasAgentProcess: (_id, _agent) => Promise.resolve(false),
  saveImageLocally: (_request: SaveImageLocallyRequest) => unavailable("local image paste"),
  pushImageToRemote: (_request: PushImageToRemoteRequest) => unavailable("remote image paste"),
};

export const hasBrowserPtyToken = (): boolean => getServerToken().trim() !== "";
