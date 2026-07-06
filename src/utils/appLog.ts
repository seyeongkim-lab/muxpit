import { invoke } from "@tauri-apps/api/core";

const enum LogLevel {
  Trace = 1,
  Debug = 2,
  Info = 3,
  Warn = 4,
  Error = 5,
}

const stringifyError = (value: unknown): string => {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const write = (level: LogLevel, message: string, extra?: unknown) => {
  const fullMessage = extra === undefined ? message : `${message}: ${stringifyError(extra)}`;
  invoke("plugin:log|log", {
    level,
    message: fullMessage,
    location: "frontend",
    file: null,
    line: null,
    keyValues: null,
  }).catch(() => {});
};

export const logInfo = (message: string, extra?: unknown) => write(LogLevel.Info, message, extra);
export const logWarn = (message: string, extra?: unknown) => write(LogLevel.Warn, message, extra);
export const logError = (message: string, extra?: unknown) => write(LogLevel.Error, message, extra);
