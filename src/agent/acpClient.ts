import type { AiKind } from "../stores/workspace.ts";
import type {
  AgentPermissionOption,
  MobileAgentEvent,
  MobileSession,
} from "../mobile/agentProtocol.ts";

type AcpProvider = Exclude<AiKind, "codex" | "claude">;
type SendLine = (line: string) => Promise<void>;
type EventHandler = (event: MobileAgentEvent) => void;
type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: JsonObject) => void;
  reject: (reason: Error) => void;
}

interface AgentCapabilities {
  loadSession?: boolean;
  sessionCapabilities?: {
    list?: JsonObject;
    resume?: JsonObject;
    close?: JsonObject;
  };
}

const asObject = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const displayValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const sessionFromValue = (provider: AcpProvider, value: unknown): MobileSession | undefined => {
  const session = asObject(value);
  const id = asString(session?.sessionId);
  const cwd = asString(session?.cwd);
  if (!session || !id) return undefined;
  const updatedAt = asString(session.updatedAt);
  return {
    id,
    title: asString(session.title) ?? "New session",
    ...(cwd ? { cwd } : {}),
    ...(updatedAt ? { updatedAt: Date.parse(updatedAt) / 1000 } : {}),
    provider,
  };
};

const permissionOptions = (value: unknown): AgentPermissionOption[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const option = asObject(entry);
        const id = asString(option?.optionId);
        const label = asString(option?.name);
        const kind = asString(option?.kind);
        return id && label && kind ? [{ id, label, kind }] : [];
      })
    : [];

export const normalizeAcpMessage = (
  provider: AcpProvider,
  value: unknown,
): MobileAgentEvent[] => {
  const message = asObject(value);
  if (!message) return [];

  const result = asObject(message.result);
  if (result && Array.isArray(result.sessions)) {
    return [{
      type: "sessionsLoaded",
      sessions: result.sessions
        .map((session) => sessionFromValue(provider, session))
        .filter((session): session is MobileSession => session !== undefined),
    }];
  }

  const method = asString(message.method);
  const params = asObject(message.params) ?? {};
  const sessionId = asString(params.sessionId) ?? "";
  if (method === "session/request_permission") {
    const requestId = typeof message.id === "string" || typeof message.id === "number"
      ? message.id
      : undefined;
    const toolCall = asObject(params.toolCall) ?? {};
    const itemId = asString(toolCall.toolCallId) ?? "permission";
    if (requestId === undefined || !sessionId) return [];
    return [{
      type: "approvalRequested",
      requestId,
      sessionId,
      turnId: sessionId,
      itemId,
      title: asString(toolCall.title) ?? "Permission required",
      detail: displayValue(toolCall.rawInput),
      options: permissionOptions(params.options),
    }];
  }
  if (method !== "session/update") return [];

  const update = asObject(params.update) ?? {};
  const updateType = asString(update.sessionUpdate);
  if (updateType === "agent_message_chunk" || updateType === "agent_thought_chunk") {
    const content = asObject(update.content);
    const text = asString(content?.text);
    if (!sessionId || !text) return [];
    return [{
      type: "messageDelta",
      sessionId,
      turnId: sessionId,
      itemId: asString(update.messageId) ?? `${updateType}-${sessionId}`,
      text,
    }];
  }
  if (updateType === "user_message_chunk") {
    const content = asObject(update.content);
    const text = asString(content?.text);
    return sessionId && text
      ? [{
          type: "userMessage",
          sessionId,
          itemId: asString(update.messageId) ?? `user-${sessionId}`,
          text,
        }]
      : [];
  }
  if (updateType === "tool_call" || updateType === "tool_call_update") {
    const itemId = asString(update.toolCallId);
    if (!sessionId || !itemId) return [];
    return [{
      type: "toolStarted",
      sessionId,
      itemId,
      title: asString(update.title) ?? "Tool",
      detail: displayValue(update.rawInput ?? update.content ?? update.status),
    }];
  }
  return [];
};

export class AcpClient {
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private capabilities: AgentCapabilities = {};
  private readonly provider: AcpProvider;
  private readonly sendLine: SendLine;
  private readonly onEvent: EventHandler;

  constructor(
    provider: AcpProvider,
    sendLine: SendLine,
    onEvent: EventHandler,
  ) {
    this.provider = provider;
    this.sendLine = sendLine;
    this.onEvent = onEvent;
  }

  async initialize(): Promise<void> {
    const result = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "wmux", title: "wmux", version: "0.2.0" },
    });
    this.capabilities = asObject(result.agentCapabilities) as AgentCapabilities ?? {};
    if (this.capabilities.sessionCapabilities?.list) {
      await this.listSessions();
    } else {
      this.onEvent({ type: "sessionsLoaded", sessions: [] });
    }
  }

  async listSessions(cwd?: string): Promise<void> {
    await this.request("session/list", cwd ? { cwd } : {});
  }

  async newSession(cwd: string): Promise<string> {
    const result = await this.request("session/new", { cwd, mcpServers: [] });
    const sessionId = asString(result.sessionId);
    if (!sessionId) throw new Error("Agent did not return a session id");
    return sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    if (!this.capabilities.loadSession) {
      throw new Error("This provider cannot load saved sessions");
    }
    await this.request("session/load", { sessionId, cwd, mcpServers: [] });
  }

  async prompt(sessionId: string, text: string): Promise<string> {
    const result = await this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    return asString(result.stopReason) ?? "end_turn";
  }

  cancel(sessionId: string): Promise<void> {
    return this.notify("session/cancel", { sessionId });
  }

  resolvePermission(requestId: string | number, optionId?: string): Promise<void> {
    return this.send({
      jsonrpc: "2.0",
      id: requestId,
      result: {
        outcome: optionId
          ? { outcome: "selected", optionId }
          : { outcome: "cancelled" },
      },
    });
  }

  receive(line: string): void {
    let message: JsonObject;
    try {
      const parsed = asObject(JSON.parse(line) as unknown);
      if (!parsed) throw new Error("Expected a JSON object");
      message = parsed;
    } catch (error) {
      this.onEvent({ type: "error", message: error instanceof Error ? error.message : String(error) });
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        const error = asObject(message.error);
        if (error) {
          pending.reject(new Error(asString(error.message) ?? "ACP request failed"));
        } else {
          pending.resolve(asObject(message.result) ?? {});
        }
      }
    }
    for (const event of normalizeAcpMessage(this.provider, message)) this.onEvent(event);
  }

  close(reason = "Agent channel closed"): void {
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
  }

  private async request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const response = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      await this.send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return response;
  }

  private notify(method: string, params: JsonObject): Promise<void> {
    return this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: JsonObject): Promise<void> {
    return this.sendLine(JSON.stringify(message));
  }
}
