import type { SshConnection } from "./sshConnection";

export interface PtyOutput {
  id: number;
  data: string;
  surfaceId?: string | null;
}

export interface PtyExit {
  id: number;
  code: number | null;
  surfaceId?: string | null;
}

export interface ShellContext {
  ssh_command: string | null;
  cwd: string | null;
}

export interface SpawnPtyRequest {
  rows: number;
  cols: number;
  command: string | null;
  commandArgv: string[] | null;
  workspaceId: string;
  surfaceId: string;
}

export interface SpawnTmuxCcRequest {
  rows: number;
  cols: number;
  sshCommand: string;
  sshConnection: SshConnection | null;
  sessionName: string;
  workspaceId: string;
  surfaceId: string;
}

export interface PushImageToRemoteRequest {
  sshCommand: string;
  sshConnection: SshConnection | null;
  imageBase64: string;
}

export interface PtyBackend {
  onOutput(handler: (payload: PtyOutput) => void): Promise<() => void>;
  onExit(handler: (payload: PtyExit) => void): Promise<() => void>;
  spawn(request: SpawnPtyRequest): Promise<number>;
  spawnTmuxCc(request: SpawnTmuxCcRequest): Promise<number>;
  write(id: number, data: string): Promise<void>;
  resize(id: number, rows: number, cols: number): Promise<void>;
  kill(id: number): Promise<void>;
  getShellContext(id: number): Promise<ShellContext>;
  pushImageToRemote(request: PushImageToRemoteRequest): Promise<string>;
}

export interface SpawnTerminalPtyRequest {
  rows: number;
  cols: number;
  spawnCommand: string | null;
  spawnCommandArgv: string[] | null;
  spawnSshConnection: SshConnection | null;
  tmuxSession?: string;
  workspaceId: string;
  leafId: string;
}

export const spawnTerminalPty = (
  backend: Pick<PtyBackend, "spawn" | "spawnTmuxCc">,
  request: SpawnTerminalPtyRequest,
): Promise<number> => {
  if (request.tmuxSession && request.spawnCommand) {
    return backend.spawnTmuxCc({
      rows: request.rows,
      cols: request.cols,
      sshCommand: request.spawnCommand,
      sshConnection: request.spawnSshConnection,
      sessionName: request.tmuxSession,
      workspaceId: request.workspaceId,
      surfaceId: request.leafId,
    });
  }

  return backend.spawn({
    rows: request.rows,
    cols: request.cols,
    command: request.spawnCommand,
    commandArgv: request.spawnCommandArgv,
    workspaceId: request.workspaceId,
    surfaceId: request.leafId,
  });
};
