import type { RuntimePlatform } from "./runtimePlatform.ts";

export type TerminalOutputEvent =
  | { type: "cwd"; cwd: string }
  | { type: "title"; title: string }
  | { type: "notification"; title: string; body: string }
  | { type: "gitBranch"; branch: string | null }
  | { type: "historyCommand"; command: string };

interface NormalizeOsc7CwdOptions {
  host?: string;
  platform?: RuntimePlatform;
}

interface ParseTerminalOutputOptions {
  platform?: RuntimePlatform;
}

const MAX_PENDING_OSC_BYTES = 8192;

const decodeOscPath = (rawPath: string): string => {
  // cmd.exe's prompt hook can only expose the raw Windows path. Do not URI-decode
  // those backslash drive/UNC paths: a literal directory named `100%2Fdone` must
  // not turn into `100/done`.
  if (/^\/?[A-Za-z]:\\/.test(rawPath) || /^\/\\\\/.test(rawPath)) return rawPath;
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
};

const normalizeWindowsSlashes = (path: string): string => path.replace(/\//g, "\\");

export const normalizeOsc7Cwd = (
  rawPath: string,
  options: NormalizeOsc7CwdOptions = {},
): string => {
  const decoded = decodeOscPath(rawPath);
  const host = options.host ?? "";
  if (/^\/[A-Za-z]:\//.test(decoded)) return decoded.slice(1);
  if (/^\/[A-Za-z]:\\/.test(decoded)) return decoded.slice(1);
  if (options.platform === "windows" && decoded.startsWith("//")) {
    return `\\\\${normalizeWindowsSlashes(decoded.slice(2))}`;
  }
  if (decoded.startsWith("/\\\\")) return decoded.slice(1);
  if (
    options.platform === "windows" &&
    host &&
    host.toLowerCase() !== "localhost" &&
    decoded.startsWith("/")
  ) {
    return `\\\\${host}${normalizeWindowsSlashes(decoded)}`;
  }
  return decoded;
};

export class TerminalOutputParser {
  private pending = "";
  private readonly options: ParseTerminalOutputOptions;

  constructor(options: ParseTerminalOutputOptions = {}) {
    this.options = options;
  }

  // Cheap pre-check so callers can skip parse() entirely for chunks that
  // can't contain an OSC sequence (e.g. CSI-only colored build/log output).
  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  parse(data: string): TerminalOutputEvent[] {
    const input = this.pending + data;
    this.pending = "";

    const lastOscStart = input.lastIndexOf("\x1b]");
    if (lastOscStart !== -1) {
      const tail = input.slice(lastOscStart);
      if (!/(?:\x07|\x1b\\)/.test(tail) && tail.length <= MAX_PENDING_OSC_BYTES) {
        this.pending = tail;
        return parseTerminalOutputEvents(input.slice(0, lastOscStart), this.options);
      }
    }

    return parseTerminalOutputEvents(input, this.options);
  }

  reset(): void {
    this.pending = "";
  }
}

export const parseTerminalOutputEvents = (
  data: string,
  options: ParseTerminalOutputOptions = {},
): TerminalOutputEvent[] => {
  const events: TerminalOutputEvent[] = [];

  const decodeHost = (rawHost: string): string => {
    try {
      return decodeURIComponent(rawHost);
    } catch {
      return rawHost;
    }
  };

  // OSC 7: current working directory
  // Format: \e]7;file://hostname/path\a  or \e]7;file://hostname/path\e\\
  const osc7Re = /\x1b\]7;file:\/\/([^\x07\x1b/]*)([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  let match;
  while ((match = osc7Re.exec(data)) !== null) {
    const cwd = normalizeOsc7Cwd(match[2], {
      host: decodeHost(match[1]),
      platform: options.platform,
    });
    if (cwd) events.push({ type: "cwd", cwd });
  }

  // OSC 0/2: terminal title. Some full-screen CLIs use this for session context.
  const titleRe = /\x1b\](?:0|2);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  while ((match = titleRe.exec(data)) !== null) {
    const title = match[1].trim();
    if (title) events.push({ type: "title", title });
  }

  // OSC 777: custom notifications and metadata
  const notifyRe = /\x1b\]777;notify;([^;]*);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  while ((match = notifyRe.exec(data)) !== null) {
    events.push({ type: "notification", title: match[1], body: match[2] });
  }

  const gitRe = /\x1b\]777;git;([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  while ((match = gitRe.exec(data)) !== null) {
    const branch = match[1].trim();
    events.push({ type: "gitBranch", branch: branch || null });
  }

  const commandRe = /\x1b\]777;cmd;([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  while ((match = commandRe.exec(data)) !== null) {
    const command = match[1];
    if (command) events.push({ type: "historyCommand", command });
  }

  return events;
};
