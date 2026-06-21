import { buildCommandLine, splitCommandLine } from "./sshConnection.ts";

export type RestorableAgentKind = "codex" | "claude";

export interface GeneratedAgentResumeCommand {
  kind: RestorableAgentKind;
  sessionId: string;
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
const AGENT_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,512}$/;
const AGENT_DANGEROUS_FLAGS: Record<RestorableAgentKind, string> = {
  codex: "--dangerously-bypass-approvals-and-sandbox",
  claude: "--dangerously-skip-permissions",
};

const normalizeAgentProgramName = (program: string | undefined): string | undefined => {
  const basename = program?.replace(/\\/g, "/").split("/").pop();
  return basename?.replace(AGENT_EXECUTABLE_SUFFIX_RE, "").toLowerCase();
};

export const normalizeAgentSessionId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const sessionId = value.trim();
  if (!AGENT_SESSION_ID_RE.test(sessionId) || sessionId.startsWith("-")) return undefined;
  return sessionId;
};

const stripAgentDangerousFlagParts = (
  kind: RestorableAgentKind,
  parts: string[],
): string[] =>
  parts.filter((part) => part !== AGENT_DANGEROUS_FLAGS[kind]);

export const stripAgentDangerousFlags = (
  kind: RestorableAgentKind,
  command: string | undefined,
): string | undefined => {
  if (!command) return undefined;
  const parts = splitCommandLine(command);
  if (detectRestorableAgentCommand(command) !== kind) return command;
  return buildCommandLine(stripAgentDangerousFlagParts(kind, parts));
};

const agentCommandParts = (
  command: string | undefined,
  kind: RestorableAgentKind,
): string[] | undefined => {
  if (!command || detectGeneratedAgentResumeCommand(command)?.kind === kind) {
    return undefined;
  }
  const parts = splitCommandLine(command);
  return detectRestorableAgentCommand(command) === kind
    ? stripAgentDangerousFlagParts(kind, parts)
    : undefined;
};

export const buildAgentResumeCommandParts = (
  kind: RestorableAgentKind,
  sessionId: string,
  dangerouslyBypass: boolean,
  baseCommand?: string,
): string[] => {
  const normalizedSessionId = normalizeAgentSessionId(sessionId);
  if (!normalizedSessionId) return [buildAgentBaseCommand(kind)];
  const baseParts = agentCommandParts(baseCommand, kind) ?? [kind];
  if (kind === "codex") {
    return [
      ...baseParts,
      "resume",
      ...(dangerouslyBypass ? [AGENT_DANGEROUS_FLAGS.codex] : []),
      normalizedSessionId,
    ];
  }

  return [
    ...baseParts,
    ...(dangerouslyBypass ? [AGENT_DANGEROUS_FLAGS.claude] : []),
    "--resume",
    normalizedSessionId,
  ];
};

export const buildAgentResumeCommand = (
  kind: RestorableAgentKind,
  sessionId: string,
  dangerouslyBypass: boolean,
  baseCommand?: string,
): string => buildCommandLine(buildAgentResumeCommandParts(kind, sessionId, dangerouslyBypass, baseCommand));

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
    if (!sessionId) return undefined;
    return { kind, sessionId, dangerouslyBypass };
  }

  const resumeIndex = parts.indexOf("--resume", 1);
  if (resumeIndex < 0) return undefined;
  const dangerouslyBypass = parts.includes("--dangerously-skip-permissions");
  const sessionId = normalizeAgentSessionId(parts[resumeIndex + 1]);
  if (!sessionId) return undefined;
  return {
    kind,
    sessionId,
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
