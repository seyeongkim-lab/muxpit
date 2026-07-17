import {
  normalizeCodexMessage,
  type MobileAgentEvent,
} from "./agentProtocol.ts";
import type { AgentExecutionSettings } from "./agentSessionRuntime.ts";

type SendLine = (line: string) => Promise<void>;
type EventHandler = (event: MobileAgentEvent) => void;

interface PendingRequest {
  method: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

const NORMALIZED_RESPONSE_METHODS = new Set([
  "thread/list",
  "thread/start",
  "thread/resume",
]);

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  defaultServiceTier: string | null;
  serviceTiers: Array<{ id: string; name: string }>;
}

export interface CodexSessionStartResult {
  threadId: string;
  settings: AgentExecutionSettings;
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const effectiveSettings = (value: Record<string, unknown>): AgentExecutionSettings => ({
  model: typeof value.model === "string" ? value.model : null,
  effort: typeof value.reasoningEffort === "string" ? value.reasoningEffort : null,
  serviceTier: typeof value.serviceTier === "string" ? value.serviceTier : null,
});

const settingOverrides = (
  settings?: AgentExecutionSettings,
  includeEffort = true,
): Record<string, string> => settings
  ? Object.fromEntries([
      ["model", settings.model],
      ...(includeEffort ? [["effort", settings.effort]] : []),
      ["serviceTier", settings.serviceTier],
    ].filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  : {};

const modelOption = (value: unknown): CodexModelOption | undefined => {
  const model = asObject(value);
  if (
    !model
    || typeof model.id !== "string"
    || typeof model.model !== "string"
    || typeof model.displayName !== "string"
    || typeof model.defaultReasoningEffort !== "string"
  ) return undefined;
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.flatMap((value) => {
        const effort = asObject(value)?.reasoningEffort;
        return typeof effort === "string" ? [effort] : [];
      })
    : [];
  const tiers = Array.isArray(model.serviceTiers)
    ? model.serviceTiers.flatMap((value) => {
        const tier = asObject(value);
        return typeof tier?.id === "string" && typeof tier.name === "string"
          ? [{ id: tier.id, name: tier.name }]
          : [];
      })
    : [];
  return {
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    isDefault: model.isDefault === true,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportedReasoningEfforts: efforts,
    defaultServiceTier: typeof model.defaultServiceTier === "string"
      ? model.defaultServiceTier
      : null,
    serviceTiers: tiers,
  };
};

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
        version: "0.2.9",
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

  async listModels(): Promise<CodexModelOption[]> {
    const result = await this.request("model/list", { limit: 100 });
    return Array.isArray(result.data)
      ? result.data.map(modelOption).filter((model): model is CodexModelOption => model !== undefined)
      : [];
  }

  async startSession(
    cwd?: string,
    settings?: AgentExecutionSettings,
  ): Promise<CodexSessionStartResult> {
    const result = await this.request("thread/start", {
      ...(cwd ? { cwd } : {}),
      ...settingOverrides(settings, false),
    });
    const thread = asObject(result.thread);
    const threadId = typeof thread?.id === "string" ? thread.id : undefined;
    if (!threadId) throw new Error("Codex did not return a thread id");
    return { threadId, settings: effectiveSettings(result) };
  }

  async resumeSession(threadId: string): Promise<AgentExecutionSettings> {
    return effectiveSettings(await this.request("thread/resume", { threadId }));
  }

  async updateSessionSettings(
    threadId: string,
    settings: AgentExecutionSettings,
  ): Promise<void> {
    await this.request("thread/settings/update", { threadId, ...settings });
  }

  async startTurn(
    threadId: string,
    text: string,
    cwd?: string,
    settings?: AgentExecutionSettings,
  ): Promise<void> {
    await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
      ...(cwd ? { cwd } : {}),
      ...settingOverrides(settings),
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

    const isResponse = message.method === undefined
      && ("result" in message || "error" in message);
    if (isResponse && typeof message.id === "number") {
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
        if (NORMALIZED_RESPONSE_METHODS.has(pending.method)) {
          for (const event of normalizeCodexMessage(message)) this.onEvent(event);
        }
        return;
      }
    }

    if (isResponse) return;

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
      this.pending.set(id, { method, resolve, reject });
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
