import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "js-yaml";

export function normalizeLogger(logger) {
  if (typeof logger === "function") {
    return { log: logger };
  }
  if (logger && typeof logger === "object") {
    return logger;
  }
  return {};
}

export function emitLog(logger, message) {
  if (typeof logger?.log !== "function") {
    return;
  }
  try {
    logger.log(message);
  } catch {
    // best effort
  }
}

export function truncateText(value, maxLen = 240) {
  if (!value) return "";
  const text = String(value).trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

export function sanitizeForLog(value, maxLen = 180) {
  if (!value) return "";
  return truncateText(String(value).replace(/\s+/g, " ").trim(), maxLen);
}

export function isTruthyEnv(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function getBoundedEnvInt(envName, fallback, min, max) {
  const fallbackNumber = Number(fallback);
  const normalizedFallback = Number.isFinite(fallbackNumber)
    ? Math.min(Math.max(Math.round(fallbackNumber), min), max)
    : min;
  const raw = process.env[envName];
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return normalizedFallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

export function parseCommandParts(commandLine) {
  const normalized = String(commandLine || "").trim();
  if (!normalized) {
    return { command: "", args: [] };
  }
  const parts = [];
  let current = "";
  let quote = "";
  let tokenStarted = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const nextChar = normalized[index + 1];

    if (quote === "'") {
      if (char === "'") {
        quote = "";
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }

    if (quote === "\"") {
      if (char === "\"") {
        quote = "";
        continue;
      }
      if (char === "\\") {
        if (nextChar === "\"" || nextChar === "\\") {
          current += nextChar;
          tokenStarted = true;
          index += 1;
          continue;
        }
        current += "\\";
        tokenStarted = true;
        continue;
      }
      current += char;
      tokenStarted = true;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (char === "\\") {
      if (nextChar && (/\s/.test(nextChar) || nextChar === "\"" || nextChar === "'" || nextChar === "\\")) {
        current += nextChar;
        tokenStarted = true;
        index += 1;
        continue;
      }
      current += "\\";
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        parts.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (quote) {
    throw new Error(`Invalid command line: unterminated ${quote === "\"" ? "double" : "single"} quote`);
  }

  if (tokenStarted) {
    parts.push(current);
  }

  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

export function resolveConductorConfigPath(configFilePath) {
  const home = os.homedir();
  return configFilePath || process.env.CONDUCTOR_CONFIG || path.join(home, ".conductor", "config.yaml");
}

export function loadYamlConfig(configFilePath) {
  try {
    const configPath = resolveConductorConfigPath(configFilePath);
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const content = fs.readFileSync(configPath, "utf8");
    const parsed = yaml.load(content);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function loadAllowCliList(configFilePath) {
  const parsed = loadYamlConfig(configFilePath);
  if (parsed && parsed.allow_cli_list && typeof parsed.allow_cli_list === "object") {
    return parsed.allow_cli_list;
  }
  return {};
}

export function loadEnvConfig(configFilePath) {
  const parsed = loadYamlConfig(configFilePath);
  if (parsed && parsed.envs && typeof parsed.envs === "object") {
    return parsed.envs;
  }
  return null;
}

export function proxyToEnv(envConfig) {
  if (!envConfig || typeof envConfig !== "object") {
    return {};
  }
  const env = {};
  const mappings = {
    http_proxy: ["HTTP_PROXY", "http_proxy"],
    https_proxy: ["HTTPS_PROXY", "https_proxy"],
    all_proxy: ["ALL_PROXY", "all_proxy"],
    no_proxy: ["NO_PROXY", "no_proxy"],
  };
  for (const [key, envKeys] of Object.entries(mappings)) {
    const value = envConfig[key] || envConfig[key.toUpperCase()];
    if (!value) {
      continue;
    }
    for (const envKey of envKeys) {
      env[envKey] = value;
    }
  }
  return env;
}

export function withoutCopilotGithubTokenEnv(env) {
  const next = env && typeof env === "object" ? { ...env } : {};
  for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    delete next[key];
  }
  return next;
}

export function serializeError(error) {
  if (error instanceof Error) {
    const payload = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    for (const key of Object.keys(error)) {
      payload[key] = error[key];
    }
    return payload;
  }
  if (error && typeof error === "object") {
    return { ...error, message: String(error.message || "Unknown error") };
  }
  return { message: String(error || "Unknown error") };
}

export function reviveError(payload) {
  const error = new Error(String(payload?.message || "Unknown error"));
  if (payload && typeof payload === "object") {
    if (payload.name) {
      error.name = String(payload.name);
    }
    if (payload.stack) {
      error.stack = String(payload.stack);
    }
    for (const [key, value] of Object.entries(payload)) {
      if (key === "name" || key === "message" || key === "stack") {
        continue;
      }
      error[key] = value;
    }
  }
  return error;
}
