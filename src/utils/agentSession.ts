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
   * Sanitized command to fall back to when generated resume commands are stripped.
   * Undefined means the pane originally came from the default local shell.
   */
  baseCommand?: string;
  /**
   * Sanitized argv form of baseCommand. This is preferred for spawning so
   * platform-specific shell quoting does not change the executable or options.
   */
  baseCommandArgv?: string[];
  cwd?: string;
  event?: string;
  updatedAt: number;
}

export const isRestorableAgentKind = (value: unknown): value is RestorableAgentKind =>
  value === "codex" || value === "claude";

export const isAgentSessionEndEvent = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  return ["sessionend", "session-end", "session_end"].includes(
    value.trim().toLowerCase(),
  );
};

const AGENT_EXECUTABLE_SUFFIX_RE = /\.(?:exe|cmd|bat|ps1)$/i;
const AGENT_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,512}$/;
const AGENT_DANGEROUS_FLAGS: Record<RestorableAgentKind, string> = {
  codex: "--dangerously-bypass-approvals-and-sandbox",
  claude: "--dangerously-skip-permissions",
};

interface AgentOptionPolicy {
  valueOptions: Set<string>;
  flagOptions: Set<string>;
  droppedOptions: Set<string>;
  droppedOptionPrefixes?: string[];
  nonRestorableCommands: Set<string>;
  resumeCommand?: string;
}

export interface SanitizedAgentBaseCommand {
  kind: RestorableAgentKind;
  command: string;
  argv: string[];
}

const CODEX_POLICY: AgentOptionPolicy = {
  valueOptions: new Set([
    "--config",
    "-c",
    "--model",
    "-m",
    "--local-provider",
    "--profile",
    "-p",
    "--sandbox",
    "-s",
    "--ask-for-approval",
    "-a",
    "--cd",
    "-C",
    "--add-dir",
    "--enable",
    "--disable",
  ]),
  flagOptions: new Set([
    "--oss",
    "--search",
    "--no-alt-screen",
    "--strict-config",
  ]),
  droppedOptions: new Set([
    AGENT_DANGEROUS_FLAGS.codex,
    "--config",
    "-c",
    "--dangerously-bypass-hook-trust",
    "--image",
    "-i",
    "--remote",
    "--remote-auth-token-env",
    "--last",
    "--all",
    "--include-non-interactive",
  ]),
  droppedOptionPrefixes: [
    "--image=",
    "-i=",
    "--remote=",
    "--remote-auth-token-env=",
  ],
  nonRestorableCommands: new Set([
    "exec",
    "e",
    "review",
    "login",
    "logout",
    "mcp",
    "mcp-server",
    "app-server",
    "app",
    "remote-control",
    "completion",
    "update",
    "doctor",
    "sandbox",
    "debug",
    "apply",
    "a",
    "fork",
    "cloud",
    "exec-server",
    "features",
    "archive",
    "delete",
    "unarchive",
    "help",
  ]),
  resumeCommand: "resume",
};

const CLAUDE_POLICY: AgentOptionPolicy = {
  valueOptions: new Set([
    "--add-dir",
    "--agent",
    "--agents",
    "--allowedTools",
    "--allowed-tools",
    "--append-system-prompt",
    "--betas",
    "--debug-file",
    "--disallowedTools",
    "--disallowed-tools",
    "--effort",
    "--fallback-model",
    "--mcp-config",
    "--model",
    "-m",
    "--name",
    "-n",
    "--permission-mode",
    "--plugin-dir",
    "--settings",
    "--system-prompt",
    "--tools",
  ]),
  flagOptions: new Set([
    "--ax-screen-reader",
    "--bare",
    "--brief",
    "--chrome",
    "--debug",
    "--disable-slash-commands",
    "--exclude-dynamic-system-prompt-sections",
    "--ide",
    "--no-chrome",
    "--strict-mcp-config",
  ]),
  droppedOptions: new Set([
    AGENT_DANGEROUS_FLAGS.claude,
    "--allow-dangerously-skip-permissions",
    "--continue",
    "-c",
    "--file",
    "--fork-session",
    "--from-pr",
    "--resume",
    "-r",
    "--session-id",
    "--tmux",
    "--worktree",
    "-w",
  ]),
  droppedOptionPrefixes: [
    "--file=",
    "--fork-session=",
    "--from-pr=",
    "--resume=",
    "--session-id=",
    "--tmux=",
    "--worktree=",
    "-r=",
    "-w=",
  ],
  nonRestorableCommands: new Set([
    "agents",
    "auth",
    "auto-mode",
    "api-key",
    "config",
    "doctor",
    "install",
    "mcp",
    "plugin",
    "plugins",
    "rc",
    "remote-control",
    "setup-token",
    "update",
    "upgrade",
    "help",
  ]),
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

const policyForKind = (kind: RestorableAgentKind): AgentOptionPolicy =>
  kind === "codex" ? CODEX_POLICY : CLAUDE_POLICY;

const optionName = (arg: string): string => {
  const equals = arg.indexOf("=");
  return equals < 0 ? arg : arg.slice(0, equals);
};

const optionHasAttachedValue = (arg: string): boolean => arg.includes("=");

const dangerousEquivalentWidth = (
  kind: RestorableAgentKind,
  parts: string[],
  index: number,
): number | undefined => {
  const arg = parts[index];
  const name = optionName(arg);
  const attached = optionHasAttachedValue(arg) ? arg.slice(name.length + 1) : undefined;
  const next = parts[index + 1];

  if (arg === AGENT_DANGEROUS_FLAGS[kind]) return 1;
  if (kind === "codex") {
    if (name === "--sandbox" || name === "-s") {
      const value = attached ?? next;
      return value === "danger-full-access" ? attached === undefined ? 2 : 1 : undefined;
    }
    if (name === "--ask-for-approval" || name === "-a") {
      const value = attached ?? next;
      return value === "never" ? attached === undefined ? 2 : 1 : undefined;
    }
    if (arg === "--dangerously-bypass-hook-trust") return 1;
  }
  if (kind === "claude") {
    if (name === "--permission-mode") {
      const value = attached ?? next;
      return value === "bypassPermissions" ? attached === undefined ? 2 : 1 : undefined;
    }
    if (arg === "--allow-dangerously-skip-permissions") return 1;
  }
  return undefined;
};

const optionWidth = (
  parts: string[],
  index: number,
  policy: AgentOptionPolicy,
): number | undefined => {
  const arg = parts[index];
  const name = optionName(arg);
  if (policy.flagOptions.has(name)) return 1;
  if (policy.valueOptions.has(name)) {
    if (optionHasAttachedValue(arg)) return 1;
    return index + 1 < parts.length ? 2 : undefined;
  }
  if (policy.droppedOptions.has(name)) {
    if (policy.valueOptions.has(name) && !optionHasAttachedValue(arg) && index + 1 < parts.length) {
      return 2;
    }
    return 1;
  }
  if (policy.droppedOptionPrefixes?.some((prefix) => arg.startsWith(prefix))) return 1;
  return undefined;
};

const sanitizeAgentBaseCommandParts = (
  kind: RestorableAgentKind,
  parts: string[],
): string[] | undefined => {
  if (parts.length === 0) return undefined;
  const normalized = normalizeAgentProgramName(parts[0]);
  if (normalized !== kind) return undefined;

  const policy = policyForKind(kind);
  const sanitized = [parts[0]];
  let index = 1;
  while (index < parts.length) {
    const arg = parts[index];
    if (arg === "--") break;

    if (!arg.startsWith("-") || arg === "-") {
      if (policy.resumeCommand && arg === policy.resumeCommand) {
        break;
      }
      if (policy.nonRestorableCommands.has(arg)) {
        return undefined;
      }
      return undefined;
    }

    const dangerousWidth = dangerousEquivalentWidth(kind, parts, index);
    if (dangerousWidth !== undefined) {
      index += dangerousWidth;
      continue;
    }

    const name = optionName(arg);
    if (policy.droppedOptionPrefixes?.some((prefix) => arg.startsWith(prefix))) {
      index += 1;
      continue;
    }
    if (policy.droppedOptions.has(name)) {
      const width = optionWidth(parts, index, policy) ?? 1;
      index += width;
      continue;
    }

    const width = optionWidth(parts, index, policy);
    if (width === undefined) return undefined;
    sanitized.push(...parts.slice(index, index + width));
    index += width;
  }

  return sanitized;
};

export const sanitizeAgentBaseCommand = (
  kind: RestorableAgentKind,
  command: string | undefined,
): SanitizedAgentBaseCommand | undefined => {
  if (!command) return undefined;
  const argv = sanitizeAgentBaseCommandParts(kind, splitCommandLine(command));
  if (!argv) return undefined;
  return {
    kind,
    command: buildCommandLine(argv),
    argv,
  };
};

export const sanitizeAgentBaseArgv = (
  kind: RestorableAgentKind,
  argv: unknown,
): SanitizedAgentBaseCommand | undefined => {
  if (!Array.isArray(argv) || !argv.every((part): part is string => typeof part === "string")) {
    return undefined;
  }
  const sanitized = sanitizeAgentBaseCommandParts(kind, argv);
  if (!sanitized) return undefined;
  return {
    kind,
    command: buildCommandLine(sanitized),
    argv: sanitized,
  };
};

export const stripAgentDangerousFlags = (
  kind: RestorableAgentKind,
  command: string | undefined,
): string | undefined => {
  return sanitizeAgentBaseCommand(kind, command)?.command ?? command;
};

const agentCommandParts = (
  command: string | undefined,
  kind: RestorableAgentKind,
  argv?: string[],
): string[] | undefined => {
  if (argv) return sanitizeAgentBaseArgv(kind, argv)?.argv;
  return sanitizeAgentBaseCommand(kind, command)?.argv;
};

export const buildAgentResumeCommandParts = (
  kind: RestorableAgentKind,
  sessionId: string,
  dangerouslyBypass: boolean,
  baseCommand?: string,
  baseCommandArgv?: string[],
): string[] => {
  const normalizedSessionId = normalizeAgentSessionId(sessionId);
  if (!normalizedSessionId) return [buildAgentBaseCommand(kind)];
  const baseParts = agentCommandParts(baseCommand, kind, baseCommandArgv) ?? [kind];
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
  baseCommandArgv?: string[],
): string => buildCommandLine(
  buildAgentResumeCommandParts(kind, sessionId, dangerouslyBypass, baseCommand, baseCommandArgv),
);

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
    let sessionId: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--dangerously-bypass-approvals-and-sandbox") continue;
      const width = optionWidth(args, index, CODEX_POLICY);
      if (width !== undefined && arg.startsWith("-")) {
        index += width - 1;
        continue;
      }
      if (!arg.startsWith("-") || arg === "-") {
        sessionId = normalizeAgentSessionId(arg);
        break;
      }
    }
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
