import { quotePosixShellArg } from "./sshConnection.ts";

// Remote command launched inside the user's configured login shell.
//   - `/bin/sh` is only the portable trampoline; the actual CLI runs under
//     `$SHELL -lc`, so zsh users do not inherit bash-specific dotfile failures.
//   - The trailing `exec "$SHELL" -l` keeps the pane alive even when the AI CLI
//     exits non-zero (missing binary, install bailout, OAuth flow that
//     short-circuits, etc). Without this, the parent ssh closes too and the
//     pane just shows `[Process exited]` over a blank screen.
export const buildAiRemoteCommand = (command: string, cwd?: string): string => {
  const launch = cwd?.startsWith("/")
    ? `cd ${quotePosixShellArg(cwd)} && ${command}`
    : command;
  const inner = `${launch}; exec "\${SHELL:-/bin/sh}" -l`;
  const outer = [
    "shell=${SHELL:-/bin/sh}",
    'case "$shell" in sh|bash|zsh|ksh|dash|*/sh|*/bash|*/zsh|*/ksh|*/dash) wmux_shell="$shell" ;; *) wmux_shell=/bin/sh ;; esac',
    `exec "$wmux_shell" -lc ${quotePosixShellArg(inner)}`,
  ].join("; ");
  return `/bin/sh -lc ${quotePosixShellArg(outer)}`;
};
