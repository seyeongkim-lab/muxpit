import type { RestorableAgentKind } from "./agentSession";

export interface AgentProcessMonitorBinding {
  kind: Extract<RestorableAgentKind, "codex">;
  sessionId: string;
}

export interface AgentProcessMonitorEntry extends AgentProcessMonitorBinding {
  sawProcess: boolean;
  consecutiveMisses: number;
}

export interface AgentProcessMonitorUpdate {
  entry: AgentProcessMonitorEntry;
  shouldClear: boolean;
}

const isSameBinding = (
  entry: AgentProcessMonitorEntry | undefined,
  binding: AgentProcessMonitorBinding,
): boolean =>
  entry?.kind === binding.kind && entry.sessionId === binding.sessionId;

export const updateAgentProcessMonitorEntry = (
  previous: AgentProcessMonitorEntry | undefined,
  binding: AgentProcessMonitorBinding,
  processPresent: boolean,
  missThreshold = 2,
): AgentProcessMonitorUpdate => {
  const threshold = Math.max(1, missThreshold);
  const base: AgentProcessMonitorEntry = isSameBinding(previous, binding) && previous
    ? previous
    : { ...binding, sawProcess: false, consecutiveMisses: 0 };

  if (processPresent) {
    return {
      entry: {
        ...binding,
        sawProcess: true,
        consecutiveMisses: 0,
      },
      shouldClear: false,
    };
  }

  if (!base.sawProcess) {
    return {
      entry: {
        ...binding,
        sawProcess: false,
        consecutiveMisses: 0,
      },
      shouldClear: false,
    };
  }

  const consecutiveMisses = base.consecutiveMisses + 1;
  return {
    entry: {
      ...binding,
      sawProcess: true,
      consecutiveMisses,
    },
    shouldClear: consecutiveMisses >= threshold,
  };
};
