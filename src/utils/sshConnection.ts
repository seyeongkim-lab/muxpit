export type SshTtyMode = "allocate" | "force" | "disable";

export interface SshConnection {
  program: string;
  options: string[];
  target: string;
  ttyMode?: SshTtyMode;
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
  "-B",
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

const SSH_EXECUTION_MODE_OPTIONS: Record<string, SshTtyMode> = {
  "-t": "allocate",
  "-tt": "force",
  "-T": "disable",
};

const isWindowsRuntime = (): boolean =>
  typeof navigator !== "undefined" && /^win/i.test(navigator.platform ?? "");

const isSshProgram = (program: string): boolean => {
  const normalized = program.replace(/\\/g, "/").toLowerCase();
  return normalized === "ssh" || normalized.endsWith("/ssh") || normalized.endsWith("/ssh.exe");
};

const splitAttachedOptionValue = (option: string): [string, string] | null => {
  if (option.length <= 2 || !option.startsWith("-") || option.startsWith("--")) return null;
  const shortOption = option.slice(0, 2);
  if (!SSH_OPTIONS_WITH_VALUE.has(shortOption)) return null;
  return [shortOption, option.slice(2)];
};

export const splitCommandLine = (
  input: string,
  options: { windows?: boolean } = {},
): string[] => {
  const words: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  const windows = options.windows ?? isWindowsRuntime();

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "'" && !inDouble) {
      if (windows && inSingle && input[i + 1] === "'") {
        current += "'";
        i += 1;
        continue;
      }
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "\\" && !inSingle && !windows && i + 1 < input.length) {
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
  if (parts.length < 2 || !isSshProgram(parts[0])) return null;

  const options: string[] = [];
  let targetIndex = -1;
  let ttyMode: SshTtyMode | undefined;
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.startsWith("-")) {
      targetIndex = index;
      break;
    }
    const executionMode = SSH_EXECUTION_MODE_OPTIONS[part];
    if (executionMode) {
      ttyMode = executionMode;
      continue;
    }
    const attached = splitAttachedOptionValue(part);
    if (attached) {
      options.push(attached[0], attached[1]);
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
      ttyMode,
    },
    remoteCommand: remoteParts.length ? remoteParts.join(" ") : undefined,
  };
};

const ttyModeArgs = (mode: SshTtyMode | undefined): string[] => {
  if (mode === "allocate") return ["-t"];
  if (mode === "force") return ["-tt"];
  if (mode === "disable") return ["-T"];
  return [];
};

export const sshConnectionToArgv = (
  connection: SshConnection,
  options: {
    allocateTty?: boolean;
    preserveTtyMode?: boolean;
    remoteCommand?: string;
    extraOptions?: string[];
  } = {},
): string[] => {
  const ttyArgs = options.allocateTty
    ? ["-t"]
    : options.preserveTtyMode
      ? ttyModeArgs(connection.ttyMode)
      : [];
  const argv = [
    connection.program,
    ...ttyArgs,
    ...connection.options,
    ...(options.extraOptions ?? []),
    connection.target,
  ];
  if (options.remoteCommand) argv.push(options.remoteCommand);
  return argv;
};

export const sshConnectionToCommandLine = (
  connection: SshConnection,
  options: {
    allocateTty?: boolean;
    preserveTtyMode?: boolean;
    remoteCommand?: string;
    extraOptions?: string[];
  } = {},
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
    const trimmed = sshCommand.trim();
    return trimmed ? `${trimmed} ${quoteCommandArg(remoteCommand)}` : "";
  }
  return buildSshCommandWithRemoteCmdFromConnection(
    parsed.connection,
    remoteCommand,
    allocateTty,
  );
};
