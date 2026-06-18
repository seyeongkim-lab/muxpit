export interface SshConnection {
  program: string;
  options: string[];
  target: string;
}

export interface SshCommandLine {
  connection: SshConnection;
  remoteCommand?: string;
}

export const SSH_DEFAULT_OPTS = [
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ServerAliveCountMax=3",
];

const SAFE_COMMAND_ARG_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export const quoteCommandArg = (value: string): string => {
  if (value === "") return "''";
  if (SAFE_COMMAND_ARG_RE.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
};

export const quotePosixShellArg = quoteCommandArg;

export const buildCommandLine = (parts: string[]): string =>
  parts.map(quoteCommandArg).join(" ");

const SSH_OPTIONS_WITH_VALUE = new Set([
  "-b",
  "-c",
  "-D",
  "-E",
  "-e",
  "-F",
  "-I",
  "-i",
  "-J",
  "-L",
  "-l",
  "-m",
  "-O",
  "-o",
  "-p",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w",
]);

const SSH_EXECUTION_MODE_OPTIONS = new Set(["-t", "-tt", "-T"]);

export const splitCommandLine = (input: string): string[] => {
  const words: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "\\" && !inSingle && i + 1 < input.length) {
      const next = input[i + 1];
      const escapable = inDouble
        ? ['"', "\\", "$", "`"].includes(next)
        : [" ", "\t", "'", '"', "\\"].includes(next);
      if (escapable) {
        current += next;
        i += 1;
        continue;
      }
    }
    if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) words.push(current);
  return words;
};

export const parseSshCommandLine = (command: string | undefined): SshCommandLine | null => {
  if (!command) return null;
  const parts = splitCommandLine(command);
  if (parts.length < 2 || !/ssh(?:\.exe)?$/i.test(parts[0])) return null;

  const options: string[] = [];
  let targetIndex = -1;
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("-")) {
      targetIndex = index;
      break;
    }
    if (SSH_EXECUTION_MODE_OPTIONS.has(part)) {
      continue;
    }
    options.push(part);
    if (SSH_OPTIONS_WITH_VALUE.has(part) && index + 1 < parts.length) {
      index += 1;
      options.push(parts[index]);
    }
  }

  if (targetIndex === -1) return null;
  const remoteParts = parts.slice(targetIndex + 1);
  return {
    connection: {
      program: parts[0],
      options,
      target: parts[targetIndex],
    },
    remoteCommand: remoteParts.length ? remoteParts.join(" ") : undefined,
  };
};

export const sshConnectionToArgv = (
  connection: SshConnection,
  options: { allocateTty?: boolean; remoteCommand?: string; extraOptions?: string[] } = {},
): string[] => {
  const argv = [
    connection.program,
    ...(options.allocateTty ? ["-t"] : []),
    ...connection.options,
    ...(options.extraOptions ?? []),
    connection.target,
  ];
  if (options.remoteCommand) argv.push(options.remoteCommand);
  return argv;
};

export const sshConnectionToCommandLine = (
  connection: SshConnection,
  options: { allocateTty?: boolean; remoteCommand?: string; extraOptions?: string[] } = {},
): string => buildCommandLine(sshConnectionToArgv(connection, options));

export const buildSshCommandWithRemoteCmdFromConnection = (
  connection: SshConnection,
  remoteCommand: string,
  allocateTty = true,
): string =>
  sshConnectionToCommandLine(connection, {
    allocateTty,
    remoteCommand,
  });

export const buildSshCommandWithRemoteCmdFromBase = (
  sshCommand: string,
  remoteCommand: string,
  allocateTty = true,
): string => {
  const parsed = parseSshCommandLine(sshCommand);
  if (!parsed) {
    return buildCommandLine([
      "ssh",
      ...(allocateTty ? ["-t"] : []),
      remoteCommand,
    ]);
  }
  return buildSshCommandWithRemoteCmdFromConnection(
    parsed.connection,
    remoteCommand,
    allocateTty,
  );
};
