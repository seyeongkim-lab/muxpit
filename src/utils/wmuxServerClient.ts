import type { SshConnection } from "./sshConnection.ts";

export interface ServerDirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number | null;
}

export interface ServerDirResponse {
  path: string;
  entries: ServerDirEntry[];
}

export interface ServerPtyOutput {
  ptyId: number;
  data: string;
  surfaceId?: string | null;
}

export interface ServerPtyExit {
  ptyId: number;
  code: number | null;
  surfaceId?: string | null;
}

type PendingReadDir = {
  resolve: (value: ServerDirResponse) => void;
  reject: (reason: Error) => void;
};

type PendingSpawn = {
  resolve: (value: number) => void;
  reject: (reason: Error) => void;
};

type PendingInvoke = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type EventHandler = (payload: unknown) => void;

type ServerMessage =
  | { t: "dir"; reqId: number; path: string; entries: ServerDirEntry[] }
  | { t: "spawned"; id: number; ptyId: number }
  | { t: "output"; ptyId: number; data: string; surfaceId?: string | null }
  | { t: "exit"; ptyId: number; code: number | null; surfaceId?: string | null }
  | { t: "invokeResult"; reqId: number; value: unknown }
  | { t: "event"; event: string; payload: unknown }
  | { t: "error"; reqId?: number | null; message: string };

export const getServerToken = (): string => {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("token") ?? "";
};

let sharedClient: WmuxServerClient | null = null;
let sharedClientToken = "";

export const getSharedWmuxServerClient = (): WmuxServerClient => {
  const token = getServerToken();
  if (!sharedClient || sharedClientToken !== token) {
    sharedClient?.close();
    sharedClient = new WmuxServerClient(token);
    sharedClientToken = token;
  }
  return sharedClient;
};

export const buildDownloadUrl = (
  path: string,
  token = getServerToken(),
  ssh?: SshConnection | null,
): string => {
  const params = new URLSearchParams();
  params.set("token", token);
  params.set("path", path);
  // A remote workspace's files live on its SSH host, not the server. Pass the
  // connection so the server fetches over SSH (cat / tar.gz) instead of locally.
  if (ssh && ssh.program) params.set("ssh", JSON.stringify(ssh));
  return `/download?${params.toString()}`;
};

export const joinServerPath = (parent: string, name: string): string => {
  if (!parent) return name;
  if (parent.endsWith("/") || parent.endsWith("\\")) return `${parent}${name}`;
  return `${parent}/${name}`;
};

export class WmuxServerClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private nextReqId = 1;
  private pendingReadDirs = new Map<number, PendingReadDir>();
  private pendingSpawns = new Map<number, PendingSpawn>();
  private pendingInvokes = new Map<number, PendingInvoke>();
  private outputHandlers = new Set<(payload: ServerPtyOutput) => void>();
  private exitHandlers = new Set<(payload: ServerPtyExit) => void>();
  private eventHandlers = new Map<string, Set<EventHandler>>();

  constructor(private readonly token: string) {}

  readDir(path: string): Promise<ServerDirResponse> {
    if (!this.token) {
      return Promise.reject(new Error("missing token"));
    }

    const reqId = this.nextReqId++;
    return this.openSocket().then(
      (ws) =>
        new Promise<ServerDirResponse>((resolve, reject) => {
          this.pendingReadDirs.set(reqId, { resolve, reject });
          ws.send(JSON.stringify({ t: "readDir", reqId, path }));
        }),
    );
  }

  onOutput(handler: (payload: ServerPtyOutput) => void): () => void {
    this.outputHandlers.add(handler);
    return () => this.outputHandlers.delete(handler);
  }

  onExit(handler: (payload: ServerPtyExit) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  async listenEvent<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    const wrapped = (payload: unknown) => handler(payload as T);
    handlers.add(wrapped);

    if (this.token) {
      this.openSocket().catch(() => {
        handlers?.delete(wrapped);
      });
    }

    return () => {
      handlers?.delete(wrapped);
      if (handlers?.size === 0) {
        this.eventHandlers.delete(event);
      }
    };
  }

  async spawnTerminal(request: {
    rows: number;
    cols: number;
    command?: string | null;
    commandArgv?: string[] | null;
    sshConnection?: unknown | null;
    tmuxSession?: string | null;
    cwd?: string | null;
    enableCwdReporting?: boolean;
    enableAgentSessionReporting?: boolean;
    workspaceId?: string;
    surfaceId?: string;
  }): Promise<number> {
    if (!this.token) {
      return Promise.reject(new Error("missing token"));
    }
    const id = this.nextReqId++;
    const ws = await this.openSocket();
    return new Promise<number>((resolve, reject) => {
      this.pendingSpawns.set(id, { resolve, reject });
      ws.send(JSON.stringify({
        t: "spawn",
        id,
        rows: request.rows,
        cols: request.cols,
        command: request.command ?? null,
        commandArgv: request.commandArgv ?? null,
        sshConnection: request.sshConnection ?? null,
        tmuxSession: request.tmuxSession ?? null,
        cwd: request.cwd ?? null,
        enableCwdReporting: request.enableCwdReporting ?? false,
        enableAgentSessionReporting: request.enableAgentSessionReporting ?? false,
        workspaceId: request.workspaceId ?? null,
        surfaceId: request.surfaceId ?? null,
      }));
    });
  }

  async invokeCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
    if (!this.token) {
      return Promise.reject(new Error("missing token"));
    }
    const reqId = this.nextReqId++;
    const ws = await this.openSocket();
    return new Promise<T>((resolve, reject) => {
      this.pendingInvokes.set(reqId, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      ws.send(JSON.stringify({ t: "invoke", reqId, command, args }));
    });
  }

  async writePty(id: number, data: string): Promise<void> {
    const ws = await this.openSocket();
    ws.send(JSON.stringify({ t: "write", id, data }));
  }

  async resizePty(id: number, rows: number, cols: number): Promise<void> {
    const ws = await this.openSocket();
    ws.send(JSON.stringify({ t: "resize", id, rows, cols }));
  }

  async killPty(id: number): Promise<void> {
    const ws = await this.openSocket();
    ws.send(JSON.stringify({ t: "kill", id }));
  }

  close(): void {
    this.rejectAll(new Error("connection closed"));
    this.ws?.close();
    this.ws = null;
    this.connecting = null;
  }

  private openSocket(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.connecting) return this.connecting;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL("/ws", window.location.href);
    url.protocol = protocol;
    url.searchParams.set("token", this.token);

    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => {
        this.ws = ws;
        this.connecting = null;
        resolve(ws);
      });
      ws.addEventListener("message", (event) => {
        this.handleMessage(event.data);
      });
      ws.addEventListener("error", () => {
        reject(new Error("websocket error"));
      });
      ws.addEventListener("close", () => {
        this.ws = null;
        this.connecting = null;
        this.rejectAll(new Error("websocket closed"));
      });
    });

    return this.connecting;
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;

    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }

    if (msg.t === "dir") {
      const pending = this.pendingReadDirs.get(msg.reqId);
      if (!pending) return;
      this.pendingReadDirs.delete(msg.reqId);
      pending.resolve({ path: msg.path, entries: msg.entries });
      return;
    }

    if (msg.t === "spawned") {
      const pending = this.pendingSpawns.get(msg.id);
      if (!pending) return;
      this.pendingSpawns.delete(msg.id);
      pending.resolve(msg.ptyId);
      return;
    }

    if (msg.t === "output") {
      for (const handler of this.outputHandlers) handler({ ptyId: msg.ptyId, data: msg.data, surfaceId: msg.surfaceId ?? null });
      return;
    }

    if (msg.t === "exit") {
      for (const handler of this.exitHandlers) handler({ ptyId: msg.ptyId, code: msg.code, surfaceId: msg.surfaceId ?? null });
      return;
    }

    if (msg.t === "invokeResult") {
      const pending = this.pendingInvokes.get(msg.reqId);
      if (!pending) return;
      this.pendingInvokes.delete(msg.reqId);
      pending.resolve(msg.value);
      return;
    }

    if (msg.t === "event") {
      const handlers = this.eventHandlers.get(msg.event);
      if (!handlers) return;
      for (const handler of handlers) handler(msg.payload);
      return;
    }

    if (msg.t === "error") {
      const error = new Error(msg.message);
      if (typeof msg.reqId === "number") {
        if (this.rejectPendingReadDir(msg.reqId, error)) return;
        if (this.rejectPendingSpawn(msg.reqId, error)) return;
        if (this.rejectPendingInvoke(msg.reqId, error)) return;
      } else {
        this.rejectAll(error);
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pendingReadDirs.values()) {
      pending.reject(error);
    }
    this.pendingReadDirs.clear();
    for (const pending of this.pendingSpawns.values()) {
      pending.reject(error);
    }
    this.pendingSpawns.clear();
    for (const pending of this.pendingInvokes.values()) {
      pending.reject(error);
    }
    this.pendingInvokes.clear();
  }

  private rejectPendingReadDir(reqId: number, error: Error): boolean {
    const pending = this.pendingReadDirs.get(reqId);
    if (!pending) return false;
    this.pendingReadDirs.delete(reqId);
    pending.reject(error);
    return true;
  }

  private rejectPendingSpawn(reqId: number, error: Error): boolean {
    const pending = this.pendingSpawns.get(reqId);
    if (!pending) return false;
    this.pendingSpawns.delete(reqId);
    pending.reject(error);
    return true;
  }

  private rejectPendingInvoke(reqId: number, error: Error): boolean {
    const pending = this.pendingInvokes.get(reqId);
    if (!pending) return false;
    this.pendingInvokes.delete(reqId);
    pending.reject(error);
    return true;
  }
}
