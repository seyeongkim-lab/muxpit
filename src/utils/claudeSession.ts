import { quotePosixShellArg } from "./sshConnection.ts";

export const buildClaudeResumeRemoteCommand = (
  projectPath: string | undefined,
  sessionId: string,
): string => {
  const resume = `claude --resume ${quotePosixShellArg(sessionId)}`;
  const cwd = projectPath?.trim();
  return cwd ? `cd ${quotePosixShellArg(cwd)} && ${resume}` : resume;
};
