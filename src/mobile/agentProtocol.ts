export type ComposerAction = "send" | "steer" | "queue";

export type AgentProvider = "codex" | "claude" | "gemini" | "copilot" | "opencode";

export interface AgentPermissionOption {
  id: string;
  label: string;
  kind: string;
}

export type MobileAgentEvent =
  | { type: "sessionsLoaded"; sessions: MobileSession[] }
  | { type: "sessionLoaded"; session: MobileSession; items: MobileTimelineItem[] }
  | {
      type: "sessionStatus";
      sessionId: string;
      running: boolean;
      waiting: boolean;
      turnId?: string;
    }
  | { type: "turnStarted"; sessionId: string; turnId: string }
  | { type: "turnCompleted"; sessionId: string; status: string }
  | { type: "messageDelta"; sessionId: string; turnId: string; itemId: string; text: string }
  | { type: "userMessage"; sessionId: string; itemId: string; text: string }
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
      options?: AgentPermissionOption[];
    }
  | { type: "error"; message: string; sessionId?: string };

export interface MobileSession {
  id: string;
  title: string;
  cwd?: string;
  updatedAt?: number;
  provider: AgentProvider;
  /** Host-computed: the session history was written to very recently. */
  active?: boolean;
  /** Client-side expiry for the host `active` flag (ms epoch); see markSessionActivity. */
  activeUntil?: number;
}

// Session goals are stored on the host (~/.muxpit/session-goals.json) so
// every muxpit surface connected to it sees the same goal for a session.
export interface SessionGoal {
  text: string;
  status: "active" | "done";
  updatedAt: number;
}

export const sessionGoalKey = (provider: AgentProvider, sessionId: string): string =>
  `${provider}:${sessionId}`;

export const encodeSessionGoal = (goal: SessionGoal): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(goal));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const parseSessionGoalsMessage = (
  message: Record<string, unknown>,
): Record<string, SessionGoal> | null => {
  if (message.type !== "muxpit_goals" || typeof message.goals !== "object" || message.goals === null) {
    return null;
  }
  const goals: Record<string, SessionGoal> = {};
  for (const [key, value] of Object.entries(message.goals as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const goal = value as Record<string, unknown>;
    if (typeof goal.text !== "string" || !goal.text) continue;
    goals[key] = {
      text: goal.text,
      status: goal.status === "done" ? "done" : "active",
      updatedAt: typeof goal.updatedAt === "number" ? goal.updatedAt : 0,
    };
  }
  return goals;
};

export const mergeAgentSessions = (
  cached: MobileSession[],
  fresh: MobileSession[],
): MobileSession[] => {
  const sessions = new Map(cached.map((session) => [session.id, session]));
  for (const session of fresh) sessions.set(session.id, session);
  return [...sessions.values()].sort((left, right) =>
    (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
};

export const replaceAgentSessions = (fresh: MobileSession[]): MobileSession[] =>
  mergeAgentSessions([], fresh);

// A freshly created session can be missing from a list snapshot for a few
// seconds (the provider persists its history file only after the first
// prompt), so a wholesale replace would drop the session the user is working
// in. Keep current entries for the ids in `keepIds` (active/running sessions)
// until the lister catches up; everything else follows the fresh list.
export const reconcileAgentSessions = (
  fresh: MobileSession[],
  current: MobileSession[],
  keepIds: ReadonlyArray<string | null | undefined>,
): MobileSession[] => {
  const listed = new Set(fresh.map((session) => session.id));
  const kept = current.filter((session) =>
    keepIds.includes(session.id) && !listed.has(session.id));
  return mergeAgentSessions(kept, fresh);
};

// How long a host `active` flag stays trusted on the client. Longer than the
// worst healthy refresh cycle (5s interval + 30s helper timeout) so the badge
// does not flap on slow links, but short enough that it decays instead of
// lingering when refreshes stop delivering (failure backoff, dead link).
export const ACTIVE_BADGE_TTL_MS = 60_000;

/** Stamp the host `active` flag with a client-side expiry at list arrival. */
export const markSessionActivity = (
  sessions: MobileSession[],
  nowMs: number,
): MobileSession[] => sessions.map((session) => session.active
  ? { ...session, activeUntil: nowMs + ACTIVE_BADGE_TTL_MS }
  : session);

/** Whether the session was recently active on the host and the flag is fresh. */
export const isSessionActive = (session: MobileSession, nowMs: number): boolean =>
  (session.activeUntil ?? 0) > nowMs;

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

const codexSessionStatus = (thread: JsonObject): MobileAgentEvent | undefined => {
  const sessionId = stringValue(thread.id);
  const status = objectValue(thread.status);
  const statusType = stringValue(status?.type);
  if (!sessionId || !statusType) return undefined;
  let turnId: string | undefined;
  if (Array.isArray(thread.turns)) {
    for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
      const turn = objectValue(thread.turns[index]);
      if (turn?.status === "inProgress") {
        turnId = stringValue(turn.id);
        break;
      }
    }
  }
  const activeFlags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
  return {
    type: "sessionStatus",
    sessionId,
    running: statusType === "active",
    waiting: statusType === "active" && activeFlags.length > 0,
    ...(turnId ? { turnId } : {}),
  };
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
    const statuses = result.data
      .map((thread) => objectValue(thread))
      .filter((thread): thread is JsonObject => thread !== undefined)
      .map(codexSessionStatus)
      .filter((event): event is MobileAgentEvent => event !== undefined);
    return [{ type: "sessionsLoaded", sessions }, ...statuses];
  }

  const thread = objectValue(result.thread);
  const session = codexSession(thread);
  if (thread && session) {
    const status = codexSessionStatus(thread);
    return [
      { type: "sessionLoaded", session, items: codexTimeline(thread) },
      ...(status ? [status] : []),
    ];
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

  if (method === "thread/status/changed" && sessionId) {
    const statusEvent = codexSessionStatus({ id: sessionId, status: params.status });
    return statusEvent ? [statusEvent] : [];
  }

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

export const normalizeClaudeHistoryMessage = (
  value: unknown,
  sessionId?: string,
): MobileAgentEvent[] => {
  const message = objectValue(value);
  if (!message) return [];
  if (message.type === "muxpit_error") {
    return [{
      type: "error",
      message: stringValue(message.message) ?? "Claude history could not be loaded",
      ...(sessionId ? { sessionId } : {}),
    }];
  }
  if (message.type !== "muxpit_claude_session") return [];

  const sessionValue = objectValue(message.session);
  const loadedSessionId = stringValue(sessionValue?.id);
  if (!loadedSessionId) {
    return [{
      type: "error",
      message: "Claude history did not include a session id",
      ...(sessionId ? { sessionId } : {}),
    }];
  }
  const session: MobileSession = {
    id: loadedSessionId,
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
    const assistantMessage = objectValue(message.message);
    const content = assistantMessage?.content;
    const messageId = stringValue(assistantMessage?.id);
    if (!Array.isArray(content)) return [];
    const events: MobileAgentEvent[] = [];
    const textBlocks: string[] = [];
    for (const blockValue of content) {
      const block = objectValue(blockValue);
      if (block?.type === "text" && typeof block.text === "string" && block.text) {
        textBlocks.push(block.text);
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
    if (textBlocks.length > 0) {
      events.unshift({
        type: "messageCompleted",
        sessionId,
        ...(messageId ? { itemId: messageId } : {}),
        text: textBlocks.join(""),
      });
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

// stream-json control request that asks a running claude CLI to stop the
// current turn without killing the process; the CLI answers with a
// control_response (ignored by the normalizer) and a result message.
export const claudeInterruptLine = (requestId: string): string =>
  JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "interrupt" },
  });

export class ClaudeStreamNormalizer {
  private readonly messageIds = new Map<string, string>();

  receive(value: unknown): MobileAgentEvent[] {
    const message = objectValue(value);
    if (!message) return [];
    const sessionId = stringValue(message.session_id) ?? "";
    if (message.type !== "stream_event") return normalizeClaudeMessage(message);

    const event = objectValue(message.event);
    if (event?.type === "message_start") {
      const messageId = stringValue(objectValue(event.message)?.id);
      if (sessionId && messageId) this.messageIds.set(sessionId, messageId);
      return [];
    }
    if (event?.type !== "content_block_delta") return [];
    const delta = objectValue(event.delta);
    const text = delta?.type === "text_delta" ? stringValue(delta.text) : undefined;
    const itemId = this.messageIds.get(sessionId);
    return text && itemId
      ? [{ type: "messageDelta", sessionId, turnId: itemId, itemId, text }]
      : [];
  }
}
