import { buildCommandLine, splitCommandLine } from "./sshConnection.ts";

export type RestorableAgentKind = "codex" | "claude";

export interface AgentSessionBinding {
  kind: RestorableAgentKind;
  sessionId: string;
  cwd?: string;
  event?: string;
  updatedAt: number;
}

export const isRestorableAgentKind = (value: unknown): value is RestorableAgentKind =>
  value === "codex" || value === "claude";

export const buildAgentResumeCommand = (
  kind: RestorableAgentKind,
  sessionId: string,
  dangerouslyBypass: boolean,
): string => {
  if (kind === "codex") {
    return buildCommandLine([
      "codex",
      "resume",
      ...(dangerouslyBypass ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
      sessionId,
    ]);
  }

  return buildCommandLine([
    "claude",
    ...(dangerouslyBypass ? ["--dangerously-skip-permissions"] : []),
    "--resume",
    sessionId,
  ]);
};

export const buildAgentBaseCommand = (kind: RestorableAgentKind): string => kind;

export const isAgentResumeCommandForBinding = (
  command: string | undefined,
  binding: Pick<AgentSessionBinding, "kind" | "sessionId">,
): boolean =>
  command === buildAgentResumeCommand(binding.kind, binding.sessionId, false) ||
  command === buildAgentResumeCommand(binding.kind, binding.sessionId, true);

export const detectRestorableAgentCommand = (
  command: string | undefined,
): RestorableAgentKind | undefined => {
  if (!command) return undefined;
  const [program] = splitCommandLine(command);
  const normalized = program?.replace(/\\/g, "/").split("/").pop();
  return isRestorableAgentKind(normalized) ? normalized : undefined;
};
