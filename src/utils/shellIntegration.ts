import type { AiKind } from "../stores/workspace";
import { getRuntimePlatform, isPowerShellCommand, type RuntimePlatform } from "./runtimePlatform.ts";
import { parseSshCommandLine } from "./sshConnection.ts";

// Shell history capture hook: injects a bash PROMPT_COMMAND + zsh preexec hook into the spawned
// shell (local or SSH remote) so it emits OSC 777;cmd;<command> before every interactive command.
// wmux parses those sequences and stores them in the shared history store.
// The trailing `&& clear` hides the visual footprint of the injection.
export const SHELL_HISTORY_HOOK =
  '{ if [ -n "$BASH_VERSION" ]; then ' +
  '__wmux_emit() { local c=$(fc -ln -1 2>/dev/null); c="${c# }"; c="${c#\t}"; ' +
  '[ -z "$c" ] && return; [ "$c" = "$__wmux_prev" ] && return; ' +
  'case "$c" in *__wmux_emit*|*__wmux_preexec*) return;; esac; ' +
  'printf \'\\033]777;cmd;%s\\a\' "$c"; __wmux_prev="$c"; }; ' +
  'PROMPT_COMMAND="__wmux_emit;${PROMPT_COMMAND:-}"; ' +
  'elif [ -n "$ZSH_VERSION" ]; then ' +
  'autoload -Uz add-zsh-hook; ' +
  '__wmux_preexec() { case "$1" in *__wmux_emit*|*__wmux_preexec*) return;; esac; ' +
  'printf \'\\033]777;cmd;%s\\a\' "$1"; }; ' +
  'add-zsh-hook preexec __wmux_preexec; ' +
  'fi; } 2>/dev/null && clear\r';

const AI_CLI_COMMAND_PATTERN = /(?:^|[\s"'\/])(claude|codex|gemini|copilot|opencode)(?=$|[\s;"'])/i;

export type ShellHistoryHookTarget =
  | "local-posix"
  | "local-windows"
  | "spawn-posix"
  | "spawn-windows"
  | "unknown";

export interface ShellHistoryHookContext {
  aiKind?: AiKind;
  spawnCommand: string | null;
  tmuxSession?: string;
  target: ShellHistoryHookTarget;
}

export const isAiCliCommand = (command: string | null): boolean =>
  !!command && AI_CLI_COMMAND_PATTERN.test(command);

export const resolveShellHistoryHookTarget = (
  spawnCommand: string | null,
  platform: RuntimePlatform = getRuntimePlatform(),
): ShellHistoryHookTarget => {
  if (!spawnCommand) {
    if (platform === "windows") return "local-windows";
    if (platform === "unknown") return "unknown";
    return "local-posix";
  }

  if (isPowerShellCommand(spawnCommand)) return "spawn-windows";

  const parsed = parseSshCommandLine(spawnCommand, { platform });
  if (parsed?.remoteCommand && isPowerShellCommand(parsed.remoteCommand)) {
    return "spawn-windows";
  }

  return "spawn-posix";
};

const supportsShellHistoryHook = (target: ShellHistoryHookTarget): boolean =>
  target === "local-posix" || target === "spawn-posix";

export const shouldInjectShellHistoryHook = ({
  aiKind,
  spawnCommand,
  tmuxSession,
  target,
}: ShellHistoryHookContext): boolean => {
  if (aiKind || isAiCliCommand(spawnCommand)) return false;
  if (tmuxSession) return false;
  return supportsShellHistoryHook(target);
};

export const buildShellHistoryHookContext = (
  aiKind: AiKind | undefined,
  spawnCommand: string | null,
  tmuxSession: string | undefined,
  platform: RuntimePlatform = getRuntimePlatform(),
): ShellHistoryHookContext => ({
  aiKind,
  spawnCommand,
  tmuxSession,
  target: resolveShellHistoryHookTarget(spawnCommand, platform),
});
