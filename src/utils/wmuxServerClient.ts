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

type PendingReadDir = {
  resolve: (value: ServerDirResponse) => void;
  reject: (reason: Error) => void;
};

type ServerMessage =
  | { t: "dir"; reqId: number; path: string; entries: ServerDirEntry[] }
  | { t: "error"; reqId?: number | null; message: string };

export const getServerToken = (): string => {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("token") ?? "";
};

export const buildDownloadUrl = (path: string, token = getServerToken()): string => {
  const params = new URLSearchParams();
  params.set("token", token);
  params.set("path", path);
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

    if (msg.t === "error") {
      const error = new Error(msg.message);
      if (typeof msg.reqId === "number") {
        const pending = this.pendingReadDirs.get(msg.reqId);
        if (!pending) return;
        this.pendingReadDirs.delete(msg.reqId);
        pending.reject(error);
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
  }
}
