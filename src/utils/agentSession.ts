import { buildCommandLine, splitCommandLine } from "./sshConnection.ts";

export type RestorableAgentKind = "codex" | "claude";

export interface GeneratedAgentResumeCommand {
  kind: RestorableAgentKind;
  sessionId?: string;
  dangerouslyBypass: boolean;
}

export interface AgentSessionBinding {
  kind: RestorableAgentKind;
  sessionId: string;
  /**
   * Command to fall back to when generated resume commands are stripped.
   * Undefined means the pane originally came from the default local shell.
   */
  baseCommand?: string;
  cwd?: string;
  event?: string;
  updatedAt: number;
}

export const isRestorableAgentKind = (value: unknown): value is RestorableAgentKind =>
  value === "codex" || value === "claude";

const AGENT_EXECUTABLE_SUFFIX_RE = /\.(?:exe|cmd|bat|ps1)$/i;

const normalizeAgentProgramName = (program: string | undefined): string | undefined => {
  const basename = program?.replace(/\\/g, "/").split("/").pop();
  return basename?.replace(AGENT_EXECUTABLE_SUFFIX_RE, "").toLowerCase();
};

export const normalizeAgentSessionId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const sessionId = value.trim();
  if (sessionId === "" || sessionId.length > 512 || sessionId.startsWith("-")) {
    return undefined;
  }
  if (/\s|[\u0000-\u001f\u007f]/.test(sessionId)) return undefined;
  return sessionId;
};

const agentCommandParts = (
  command: string | undefined,
  kind: RestorableAgentKind,
): string[] | undefined => {
  if (!command || detectGeneratedAgentResumeCommand(command)?.kind === kind) {
    return undefined;
  }
  const parts = splitCommandLine(command);
  return detectRestorableAgentCommand(command) === kind ? parts : undefined;
};

export const buildAgentResumeCommand = (
  kind: RestorableAgentKind,
  sessionId: string,
  dangerouslyBypass: boolean,
  baseCommand?: string,
): string => {
  const normalizedSessionId = normalizeAgentSessionId(sessionId);
  if (!normalizedSessionId) return buildAgentBaseCommand(kind);
  const baseParts = agentCommandParts(baseCommand, kind) ?? [kind];
  if (kind === "codex") {
    return buildCommandLine([
      ...baseParts,
      "resume",
      ...(dangerouslyBypass ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
      normalizedSessionId,
    ]);
  }

  return buildCommandLine([
    ...baseParts,
    ...(dangerouslyBypass ? ["--dangerously-skip-permissions"] : []),
    "--resume",
    normalizedSessionId,
  ]);
};

export const buildAgentBaseCommand = (kind: RestorableAgentKind): string => kind;

export const detectGeneratedAgentResumeCommand = (
  command: string | undefined,
): GeneratedAgentResumeCommand | undefined => {
  if (!command) return undefined;
  const parts = splitCommandLine(command);
  const kind = detectRestorableAgentCommand(command);
  if (!kind) return undefined;

  if (kind === "codex") {
    const resumeIndex = parts.indexOf("resume", 1);
    if (resumeIndex < 0) return undefined;
    const args = parts.slice(resumeIndex + 1);
    const dangerouslyBypass = args.includes("--dangerously-bypass-approvals-and-sandbox");
    const sessionId = normalizeAgentSessionId(
      args.find((part) => part !== "--dangerously-bypass-approvals-and-sandbox" && !part.startsWith("-")),
    );
    return { kind, sessionId, dangerouslyBypass };
  }

  const resumeIndex = parts.indexOf("--resume", 1);
  if (resumeIndex < 0) return undefined;
  const dangerouslyBypass = parts.includes("--dangerously-skip-permissions");
  return {
    kind,
    sessionId: normalizeAgentSessionId(parts[resumeIndex + 1]),
    dangerouslyBypass,
  };
};

export const fallbackCommandForGeneratedAgentResume = (
  command: string | undefined,
): string | undefined => {
  const generated = detectGeneratedAgentResumeCommand(command);
  return generated ? buildAgentBaseCommand(generated.kind) : undefined;
};

export const isAgentResumeCommandForBinding = (
  command: string | undefined,
  binding: Pick<AgentSessionBinding, "kind" | "sessionId">,
): boolean => {
  const generated = detectGeneratedAgentResumeCommand(command);
  return (
    generated?.kind === binding.kind &&
    generated.sessionId === normalizeAgentSessionId(binding.sessionId)
  );
};

export const detectRestorableAgentCommand = (
  command: string | undefined,
): RestorableAgentKind | undefined => {
  if (!command) return undefined;
  const [program] = splitCommandLine(command);
  const normalized = normalizeAgentProgramName(program);
  return isRestorableAgentKind(normalized) ? normalized : undefined;
};
