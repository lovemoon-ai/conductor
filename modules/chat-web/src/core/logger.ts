/* eslint-disable no-console */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function envLevel(): LogLevel {
  const raw = (process.env.CHAT_WEB_LOG ?? "info").toLowerCase();
  if (raw in LEVELS) return raw as LogLevel;
  return "info";
}

export interface Logger {
  level: LogLevel;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export function createLogger(level: LogLevel = envLevel()): Logger {
  const should = (l: LogLevel) => LEVELS[l] <= LEVELS[level];

  return {
    level,
    error(...args) {
      if (should("error")) console.error("[chat-web]", ...args);
    },
    warn(...args) {
      if (should("warn")) console.warn("[chat-web]", ...args);
    },
    info(...args) {
      if (should("info")) console.error("[chat-web]", ...args);
    },
    debug(...args) {
      if (should("debug")) console.error("[chat-web:debug]", ...args);
    },
  };
}

export const defaultLogger: Logger = createLogger();
