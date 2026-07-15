import {
  normalizeCodexMessage,
  type MobileAgentEvent,
} from "./agentProtocol.ts";

type SendLine = (line: string) => Promise<void>;
type EventHandler = (event: MobileAgentEvent) => void;

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export class CodexMobileClient {
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly sendLine: SendLine;
  private readonly onEvent: EventHandler;

  constructor(
    sendLine: SendLine,
    onEvent: EventHandler,
  ) {
    this.sendLine = sendLine;
    this.onEvent = onEvent;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "wmux_mobile",
        title: "wmux Mobile",
        version: "0.2.3",
      },
    });
    await this.notify("initialized", {});
    await this.listSessions();
  }

  async listSessions(): Promise<void> {
    await this.request("thread/list", {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
    });
  }

  async startSession(cwd?: string): Promise<string> {
    const result = await this.request("thread/start", cwd ? { cwd } : {});
    const thread = asObject(result.thread);
    const threadId = typeof thread?.id === "string" ? thread.id : undefined;
    if (!threadId) throw new Error("Codex did not return a thread id");
    return threadId;
  }

  async resumeSession(threadId: string): Promise<void> {
    await this.request("thread/resume", { threadId });
  }

  async startTurn(threadId: string, text: string, cwd?: string): Promise<void> {
    await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
      ...(cwd ? { cwd } : {}),
    });
  }

  async steer(threadId: string, turnId: string, text: string): Promise<void> {
    await this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text }],
    });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async resolveApproval(requestId: string | number, accepted: boolean): Promise<void> {
    await this.send({
      id: requestId,
      result: { decision: accepted ? "accept" : "decline" },
    });
  }

  receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      const object = asObject(parsed);
      if (!object) throw new Error("Expected a JSON object");
      message = object;
    } catch (error) {
      this.onEvent({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        const error = asObject(message.error);
        if (error) {
          pending.reject(new Error(
            typeof error.message === "string" ? error.message : "Codex request failed",
          ));
        } else {
          pending.resolve(asObject(message.result) ?? {});
        }
      }
    }

    for (const event of normalizeCodexMessage(message)) this.onEvent(event);
  }

  close(reason = "Codex channel closed"): void {
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      await this.send({ method, id, params });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return response;
  }

  private notify(method: string, params: Record<string, unknown>): Promise<void> {
    return this.send({ method, params });
  }

  private send(message: Record<string, unknown>): Promise<void> {
    return this.sendLine(JSON.stringify(message));
  }
}
