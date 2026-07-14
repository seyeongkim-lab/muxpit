export type ComposerAction = "send" | "steer" | "queue";

export type MobileAgentEvent =
  | { type: "sessionsLoaded"; sessions: MobileSession[] }
  | { type: "sessionLoaded"; session: MobileSession; items: MobileTimelineItem[] }
  | { type: "turnStarted"; sessionId: string; turnId: string }
  | { type: "turnCompleted"; sessionId: string; status: string }
  | { type: "messageDelta"; sessionId: string; turnId: string; itemId: string; text: string }
  | { type: "messageCompleted"; sessionId: string; itemId?: string; text: string }
  | { type: "toolStarted"; sessionId: string; itemId: string; title: string; detail: string }
  | {
      type: "approvalRequested";
      requestId: string | number;
      sessionId: string;
      turnId: string;
      itemId: string;
      title: string;
      detail: string;
    }
  | { type: "error"; message: string };

export interface MobileSession {
  id: string;
  title: string;
  cwd?: string;
  updatedAt?: number;
  provider: "codex" | "claude";
}

export interface MobileTimelineItem {
  id: string;
  kind: "user" | "assistant" | "tool" | "status";
  text: string;
  title?: string;
}

type JsonObject = Record<string, unknown>;

const objectValue = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const stringOrEmpty = (value: unknown): string => stringValue(value) ?? "";

const displayJson = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export class JsonLineDecoder {
  private readonly decoder = new TextDecoder();
  private buffered = "";

  push(chunk: Uint8Array | string): string[] {
    this.buffered += typeof chunk === "string"
      ? chunk
      : this.decoder.decode(chunk, { stream: true });
    const lines = this.buffered.split("\n");
    this.buffered = lines.pop() ?? "";
    return lines.map((line) => line.trimEnd()).filter((line) => line.length > 0);
  }
}

export const composerAction = (running: boolean, queueMode: boolean): ComposerAction => {
  if (!running) return "send";
  return queueMode ? "queue" : "steer";
};

const codexSession = (value: unknown): MobileSession | undefined => {
  const thread = objectValue(value);
  const id = stringValue(thread?.id);
  if (!thread || !id) return undefined;
  const preview = stringValue(thread.name) ?? stringValue(thread.preview) ?? "New session";
  return {
    id,
    title: preview.trim() || "New session",
    cwd: stringValue(thread.cwd),
    updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : undefined,
    provider: "codex",
  };
};

const codexTimeline = (thread: JsonObject): MobileTimelineItem[] => {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const items: MobileTimelineItem[] = [];
  for (const turnValue of turns) {
    const turn = objectValue(turnValue);
    const turnItems = Array.isArray(turn?.items) ? turn.items : [];
    for (const itemValue of turnItems) {
      const item = objectValue(itemValue);
      const id = stringValue(item?.id) ?? `${items.length}`;
      const type = stringValue(item?.type);
      if (type === "userMessage") {
        const content = Array.isArray(item?.content) ? item.content : [];
        const text = content
          .map((entry) => stringValue(objectValue(entry)?.text))
          .filter((entry): entry is string => entry !== undefined)
          .join("\n");
        if (text) items.push({ id, kind: "user", text });
      } else if (type === "agentMessage") {
        const text = stringValue(item?.text);
        if (text) items.push({ id, kind: "assistant", text });
      } else if (type === "commandExecution") {
        const command = displayJson(item?.command);
        items.push({ id, kind: "tool", title: "Command", text: command });
      } else if (type === "fileChange") {
        items.push({ id, kind: "tool", title: "File change", text: displayJson(item?.changes) });
      }
    }
  }
  return items;
};

const normalizeCodexResponse = (message: JsonObject): MobileAgentEvent[] => {
  const result = objectValue(message.result);
  if (!result) {
    const error = objectValue(message.error);
    const errorMessage = stringValue(error?.message);
    return errorMessage ? [{ type: "error", message: errorMessage }] : [];
  }

  if (Array.isArray(result.data)) {
    const sessions = result.data
      .map(codexSession)
      .filter((session): session is MobileSession => session !== undefined);
    return [{ type: "sessionsLoaded", sessions }];
  }

  const thread = objectValue(result.thread);
  const session = codexSession(thread);
  if (thread && session) {
    return [{ type: "sessionLoaded", session, items: codexTimeline(thread) }];
  }

  return [];
};

export const normalizeCodexMessage = (value: unknown): MobileAgentEvent[] => {
  const message = objectValue(value);
  if (!message) return [];
  const method = stringValue(message.method);
  if (!method && ("result" in message || "error" in message)) {
    return normalizeCodexResponse(message);
  }

  const params = objectValue(message.params) ?? {};
  const sessionId = stringOrEmpty(params.threadId);
  const turnId = stringOrEmpty(params.turnId) || stringOrEmpty(objectValue(params.turn)?.id);

  if (method === "turn/started" && sessionId && turnId) {
    return [{ type: "turnStarted", sessionId, turnId }];
  }
  if (method === "turn/completed" && sessionId) {
    const status = stringValue(objectValue(params.turn)?.status)
      ?? stringValue(objectValue(objectValue(params.turn)?.status)?.type)
      ?? "completed";
    return [{ type: "turnCompleted", sessionId, status }];
  }
  if (method === "item/agentMessage/delta") {
    const itemId = stringOrEmpty(params.itemId);
    const text = stringOrEmpty(params.delta);
    return sessionId && turnId && itemId && text
      ? [{ type: "messageDelta", sessionId, turnId, itemId, text }]
      : [];
  }
  if (method === "item/completed") {
    const item = objectValue(params.item);
    if (stringValue(item?.type) === "agentMessage") {
      const text = stringValue(item?.text);
      const itemId = stringValue(item?.id);
      return text ? [{ type: "messageCompleted", sessionId, itemId, text }] : [];
    }
  }
  if (method === "item/started") {
    const item = objectValue(params.item);
    const itemId = stringValue(item?.id);
    const type = stringValue(item?.type);
    if (itemId && type === "commandExecution") {
      return [{
        type: "toolStarted",
        sessionId,
        itemId,
        title: "Command",
        detail: displayJson(item?.command),
      }];
    }
    if (itemId && type === "fileChange") {
      return [{
        type: "toolStarted",
        sessionId,
        itemId,
        title: "File change",
        detail: displayJson(item?.changes),
      }];
    }
  }
  if (
    method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
  ) {
    const requestId = typeof message.id === "string" || typeof message.id === "number"
      ? message.id
      : undefined;
    const itemId = stringOrEmpty(params.itemId);
    if (requestId === undefined || !sessionId || !turnId || !itemId) return [];
    const title = method.includes("commandExecution")
      ? displayJson(params.command) || "Command approval"
      : "File change approval";
    return [{
      type: "approvalRequested",
      requestId,
      sessionId,
      turnId,
      itemId,
      title,
      detail: stringValue(params.reason) ?? displayJson(params.changes),
    }];
  }

  return [];
};

export const normalizeClaudeHistoryMessage = (value: unknown): MobileAgentEvent[] => {
  const message = objectValue(value);
  if (!message) return [];
  if (message.type === "wmux_error") {
    return [{ type: "error", message: stringValue(message.message) ?? "Claude history could not be loaded" }];
  }
  if (message.type !== "wmux_claude_session") return [];

  const sessionValue = objectValue(message.session);
  const sessionId = stringValue(sessionValue?.id);
  if (!sessionId) return [{ type: "error", message: "Claude history did not include a session id" }];
  const session: MobileSession = {
    id: sessionId,
    title: stringValue(sessionValue?.title) ?? "Claude session",
    ...(typeof sessionValue?.cwd === "string" ? { cwd: sessionValue.cwd } : {}),
    ...(typeof sessionValue?.updatedAt === "number" ? { updatedAt: sessionValue.updatedAt } : {}),
    provider: "claude",
  };
  const items: MobileTimelineItem[] = [];
  if (Array.isArray(message.items)) {
    for (const value of message.items) {
      const item = objectValue(value);
      const id = stringValue(item?.id);
      const kind = stringValue(item?.kind);
      const text = stringValue(item?.text);
      if (!id || !text || !kind || !["user", "assistant", "tool", "status"].includes(kind)) continue;
      items.push({
        id,
        kind: kind as MobileTimelineItem["kind"],
        text,
        ...(typeof item?.title === "string" ? { title: item.title } : {}),
      });
    }
  }
  return [{ type: "sessionLoaded", session, items }];
};

const claudeToolDetail = (input: unknown): string => {
  const object = objectValue(input);
  return stringValue(object?.command)
    ?? stringValue(object?.file_path)
    ?? stringValue(object?.path)
    ?? displayJson(input);
};

export const normalizeClaudeMessage = (value: unknown): MobileAgentEvent[] => {
  const message = objectValue(value);
  if (!message) return [];
  const type = stringValue(message.type);
  const sessionId = stringValue(message.session_id) ?? "";
  if (type === "assistant") {
    const content = objectValue(message.message)?.content;
    if (!Array.isArray(content)) return [];
    const events: MobileAgentEvent[] = [];
    for (const blockValue of content) {
      const block = objectValue(blockValue);
      if (block?.type === "text" && typeof block.text === "string" && block.text) {
        events.push({ type: "messageCompleted", sessionId, text: block.text });
      }
      if (block?.type === "tool_use") {
        const itemId = stringValue(block.id) ?? `tool-${events.length}`;
        events.push({
          type: "toolStarted",
          sessionId,
          itemId,
          title: stringValue(block.name) ?? "Tool",
          detail: claudeToolDetail(block.input),
        });
      }
    }
    return events;
  }
  if (type === "result") {
    const subtype = stringValue(message.subtype);
    return [{
      type: "turnCompleted",
      sessionId,
      status: message.is_error === true ? "failed" : subtype === "success" ? "completed" : subtype ?? "completed",
    }];
  }
  return [];
};
