#!/usr/bin/env node
/* eslint-disable no-console */

import { doctor, formatDoctorReport } from "./commands/doctor.js";
import { info, formatInfo } from "./commands/info.js";
import { login } from "./commands/login.js";
import { ChatWebError } from "./core/errors.js";
import { createLogger, type LogLevel } from "./core/logger.js";
import { registerBuiltinProviders } from "./providers/index.js";

const USAGE = `chat-web — chat web automation runtime

Usage:
  chat-web login <provider>                       Open a browser to sign in; profile is persisted.
  chat-web doctor <provider> [--snapshot]         Inspect provider page state.
                            [--screenshot]
                            [--html]
                            [--json]
  chat-web info [<provider>] [--live] [--json]    Show login state for one or all providers.

For programmatic multi-turn chat use the SDK:

  import { ChatSession } from "@love-moon/chat-web";

  const session = await ChatSession.open("chatgpt");
  try {
    const r1 = await session.send("hello");
    const r2 = await session.send("tell me more");
    console.log(r1.response, r2.response);
  } finally {
    await session.close();
  }

Environment:
  CHAT_WEB_HOME       Override the ~/.chat-web/ root directory.
  CHAT_WEB_HEADLESS   "1" to launch Chromium headless by default.
  CHAT_WEB_LOG        silent | error | warn | info | debug
`;

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

function flagBool(flags: Map<string, string | boolean>, key: string): boolean {
  const v = flags.get(key);
  return v === true || v === "true";
}

function flagString(flags: Map<string, string | boolean>, key: string): string | undefined {
  const v = flags.get(key);
  return typeof v === "string" ? v : undefined;
}

async function main(): Promise<number> {
  registerBuiltinProviders();

  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const logLevel = (flagString(flags, "log") as LogLevel | undefined) ?? undefined;
  const logger = createLogger(
    logLevel ?? (process.env.CHAT_WEB_LOG as LogLevel | undefined) ?? "info",
  );

  switch (command) {
    case "login": {
      const provider = positional[0];
      if (!provider) throw new Error("Usage: chat-web login <provider>");
      await login(provider, {
        logger,
        autoExit: flagBool(flags, "auto-exit"),
      });
      return 0;
    }

    case "doctor": {
      const provider = positional[0];
      if (!provider) throw new Error("Usage: chat-web doctor <provider>");
      const report = await doctor(provider, {
        snapshot: flagBool(flags, "snapshot"),
        screenshot: flagBool(flags, "screenshot"),
        html: flagBool(flags, "html"),
        headless: flagBool(flags, "headless") || undefined,
        logger,
      });
      if (flagBool(flags, "json")) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatDoctorReport(report)}\n`);
      }
      return 0;
    }

    case "info": {
      const provider = positional[0]; // optional
      const rows = await info({
        provider,
        live: flagBool(flags, "live"),
        headless: flagBool(flags, "headless") || undefined,
        logger,
      });
      if (flagBool(flags, "json")) {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatInfo(rows)}\n`);
      }
      return 0;
    }

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => {
    if (typeof code === "number") process.exit(code);
  },
  (err: unknown) => {
    if (err instanceof ChatWebError) {
      process.stderr.write(`Error [${err.code}]: ${err.message}\n`);
      if (err.hint) process.stderr.write(`Hint: ${err.hint}\n`);
      process.exit(1);
    }
    process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  },
);
