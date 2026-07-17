import { spawn } from "node:child_process";

import {
  emitLog,
  normalizeLogger,
  parseCommandParts,
  sanitizeForLog,
} from "../shared.js";

const DEFAULT_KIMI_COMMAND = "kimi";
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_OUTPUT_CHARS = 128 * 1024;

function normalizeMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "prompt" || normalized === "kimi-code" || normalized === "modern") {
    return "prompt";
  }
  if (normalized === "wire" || normalized === "legacy") {
    return "wire";
  }
  return "";
}

function resolveCommandLine(options = {}) {
  return (
    process.env.CONDUCTOR_KIMI_COMMAND ||
    options.commandLine ||
    process.env.CONDUCTOR_CLI_COMMAND ||
    DEFAULT_KIMI_COMMAND
  );
}

function appendProbeOutput(current, chunk) {
  if (current.length >= MAX_PROBE_OUTPUT_CHARS) {
    return current;
  }
  return `${current}${String(chunk || "")}`.slice(0, MAX_PROBE_OUTPUT_CHARS);
}

async function readKimiHelp(options = {}) {
  const { command, args } = parseCommandParts(resolveCommandLine(options));
  if (!command) {
    throw new Error("Invalid kimi command");
  }

  const cwd =
    typeof options.cwd === "string" && options.cwd.trim()
      ? options.cwd.trim()
      : process.cwd();
  const env = {
    ...process.env,
    ...(options.env && typeof options.env === "object" ? options.env : {}),
  };

  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args, "--help"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const timeoutMs = Number.isFinite(options.kimiCliProbeTimeoutMs)
      ? Math.max(100, Number(options.kimiCliProbeTimeoutMs))
      : DEFAULT_PROBE_TIMEOUT_MS;
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
      reject(new Error(`Kimi CLI capability probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      output = appendProbeOutput(output, chunk);
    });
    child.stderr.on("data", (chunk) => {
      output = appendProbeOutput(output, chunk);
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      reject(error);
    });
    child.once("close", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve(output);
    });
  });
}

export async function resolveKimiCliMode(options = {}) {
  if (options.transport) {
    return "wire";
  }

  const configuredMode = normalizeMode(
    options.kimiCliMode ||
      options.env?.CONDUCTOR_KIMI_CLI_MODE ||
      process.env.CONDUCTOR_KIMI_CLI_MODE,
  );
  if (configuredMode) {
    return configuredMode;
  }

  const logger = normalizeLogger(options.logger);
  try {
    const helpText = await readKimiHelp(options);
    if (/(^|\s)--wire(?:\s|$)/m.test(helpText)) {
      emitLog(logger, "[kimi-detect] using legacy wire mode");
      return "wire";
    }
    if (/(^|\s)--prompt(?:\s|,|$)/m.test(helpText) && helpText.includes("--output-format")) {
      emitLog(logger, "[kimi-detect] using Kimi Code prompt mode");
      return "prompt";
    }
    emitLog(logger, "[kimi-detect] CLI mode was not recognized; keeping legacy wire mode");
  } catch (error) {
    emitLog(
      logger,
      `[kimi-detect] capability probe failed; keeping legacy wire mode: ${sanitizeForLog(error?.message || error, 180)}`,
    );
  }
  return "wire";
}
