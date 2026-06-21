import {
  buildAgentResumeCommand,
  buildAgentResumeCommandParts,
  detectRestorableAgentCommand,
  type AgentSessionBinding,
} from "./agentSession.ts";
import { buildCommandLine, type SshConnection } from "./sshConnection.ts";

export interface TerminalSpawnPlanSpec {
  command?: string;
  commandArgv?: string[];
  sshConnection?: SshConnection;
  cwd?: string;
  cwdSource?: "local" | "agent";
  agentSession?: AgentSessionBinding;
}

export interface ResolvedTerminalCommand {
  command: string | null;
  commandArgv: string[] | null;
  sshConnection: SshConnection | null;
}

export interface TerminalSpawnPlanSettings {
  enableCwdRestore: boolean;
  enableAgentSessionRestore: boolean;
  enableAgentDangerousResume: boolean;
}

export interface BuildTerminalSpawnPlanInput {
  spec: TerminalSpawnPlanSpec;
  resolved: ResolvedTerminalCommand;
  tmuxSession?: string;
  aiKind?: string;
  settings: TerminalSpawnPlanSettings;
}

export interface TerminalSpawnPlan {
  spawnCommand: string | null;
  spawnCommandArgv: string[] | null;
  spawnSshConnection: SshConnection | null;
  cwd: string | null;
  enableCwdReporting: boolean;
  enableAgentSessionReporting: boolean;
  postSpawnInput?: string;
  fallbackPostSpawnInput?: string;
  suppressShellHistoryHook: boolean;
}

const canUseLocalAgentSession = (
  spec: TerminalSpawnPlanSpec,
  resolved: ResolvedTerminalCommand,
  tmuxSession?: string,
): boolean => {
  if (!spec.agentSession || tmuxSession || resolved.sshConnection || resolved.commandArgv) {
    return false;
  }
  if (!resolved.command) return true;
  return detectRestorableAgentCommand(resolved.command) === spec.agentSession.kind;
};

const canReportLocalAgentSessions = (
  resolved: ResolvedTerminalCommand,
  tmuxSession?: string,
): boolean => {
  if (tmuxSession || resolved.sshConnection || resolved.commandArgv) return false;
  if (!resolved.command) return true;
  return detectRestorableAgentCommand(resolved.command) !== undefined;
};

export const buildTerminalSpawnPlan = ({
  spec,
  resolved,
  tmuxSession,
  aiKind,
  settings,
}: BuildTerminalSpawnPlanInput): TerminalSpawnPlan => {
  const agentSession =
    settings.enableAgentSessionRestore && canUseLocalAgentSession(spec, resolved, tmuxSession)
      ? spec.agentSession
      : undefined;
  const agentResumeParts = agentSession?.baseCommand
    ? buildAgentResumeCommandParts(
        agentSession.kind,
        agentSession.sessionId,
        settings.enableAgentDangerousResume,
        agentSession.baseCommand,
        agentSession.baseCommandArgv,
      )
    : undefined;
  const agentResumeCommand = agentSession
    ? buildAgentResumeCommand(
        agentSession.kind,
        agentSession.sessionId,
        settings.enableAgentDangerousResume,
        agentSession.baseCommand,
        agentSession.baseCommandArgv,
      )
    : undefined;
  const shellResumeInput =
    agentSession && !agentSession.baseCommand && agentResumeCommand
      ? `${agentResumeCommand}\r`
      : undefined;
  const directResumeCommand = agentResumeParts ? buildCommandLine(agentResumeParts) : undefined;
  const spawnCommand = directResumeCommand ?? resolved.command;
  const spawnCommandArgv = agentResumeParts ?? resolved.commandArgv;
  const enableAgentSessionReporting =
    settings.enableAgentSessionRestore &&
    (agentSession !== undefined || canReportLocalAgentSessions(resolved, tmuxSession));

  return {
    spawnCommand,
    spawnCommandArgv,
    spawnSshConnection: resolved.sshConnection,
    cwd: spec.cwdSource === "agent"
      ? settings.enableAgentSessionRestore ? spec.cwd ?? null : null
      : settings.enableCwdRestore ? spec.cwd ?? null : null,
    enableCwdReporting:
      settings.enableCwdRestore &&
      !spec.command &&
      !spec.commandArgv &&
      !tmuxSession &&
      !aiKind,
    enableAgentSessionReporting,
    postSpawnInput: shellResumeInput,
    fallbackPostSpawnInput: agentResumeCommand ? `${agentResumeCommand}\r` : undefined,
    suppressShellHistoryHook: agentSession !== undefined,
  };
};
