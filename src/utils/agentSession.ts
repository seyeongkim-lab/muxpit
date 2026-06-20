import { buildCommandLine } from "./sshConnection.ts";

export type RestorableAgentKind = "codex" | "claude";

export interface AgentSessionBinding {
  kind: RestorableAgentKind;
  sessionId: string;
  cwd?: string;
  transcriptPath?: string;
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
