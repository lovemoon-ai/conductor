import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "js-yaml";

export const DEFAULT_CONDUCTOR_CONFIG_BASENAME = "config.yaml";
export const DEFAULT_SERVE_AI_CONFIG_BASENAME = "config-ai-serve.yaml";

function resolvePrimaryConfigPath(configFilePath) {
  if (typeof configFilePath === "string" && configFilePath.trim()) {
    return path.resolve(configFilePath.trim());
  }
  if (typeof process.env.CONDUCTOR_CONFIG === "string" && process.env.CONDUCTOR_CONFIG.trim()) {
    return path.resolve(process.env.CONDUCTOR_CONFIG.trim());
  }
  return path.join(os.homedir(), ".conductor", DEFAULT_CONDUCTOR_CONFIG_BASENAME);
}

export function resolveServeAiConfigPaths(configFilePath) {
  const conductorConfigPath = resolvePrimaryConfigPath(configFilePath);
  return {
    conductorConfigPath,
    serveAiConfigPath: path.join(path.dirname(conductorConfigPath), DEFAULT_SERVE_AI_CONFIG_BASENAME),
  };
}

function parseYamlFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const parsed = yaml.load(content);
  if (parsed == null) {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected YAML mapping in ${filePath}`);
  }
  return parsed;
}

export function loadServeAiRuntimeConfig(configFilePath) {
  const { conductorConfigPath, serveAiConfigPath } = resolveServeAiConfigPaths(configFilePath);
  const conductorExists = fs.existsSync(conductorConfigPath);
  const serveAiExists = fs.existsSync(serveAiConfigPath);

  let activeConfigPath = conductorConfigPath;
  let source = "conductor";
  if (!conductorExists && serveAiExists) {
    activeConfigPath = serveAiConfigPath;
    source = "serve-ai";
  }

  let parsed = {};
  if (fs.existsSync(activeConfigPath)) {
    parsed = parseYamlFile(activeConfigPath);
  }

  return {
    conductorConfigPath,
    serveAiConfigPath,
    activeConfigPath,
    source,
    parsed,
    allowCliList:
      parsed && parsed.allow_cli_list && typeof parsed.allow_cli_list === "object"
        ? parsed.allow_cli_list
        : {},
    envs:
      parsed && parsed.envs && typeof parsed.envs === "object"
        ? parsed.envs
        : {},
    defaults:
      parsed && parsed.serve_ai && typeof parsed.serve_ai === "object"
        ? parsed.serve_ai
        : {},
  };
}

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function buildServeAiConfigYaml({
  backend = "codex",
  host = "127.0.0.1",
  port = 8787,
  apiKey = "",
} = {}) {
  const lines = [
    "# Dedicated config for `conductor serve-ai`.",
    "# This file is used when the sibling config.yaml does not exist.",
    "",
    "serve_ai:",
    `  host: ${yaml.dump(host).trim()}`,
    `  port: ${Number.isFinite(Number(port)) ? Number(port) : 8787}`,
    `  backend: ${yaml.dump(backend).trim()}`,
  ];

  const normalizedApiKey = normalizeOptionalString(apiKey);
  if (normalizedApiKey) {
    lines.push(`  api_key: ${yaml.dump(normalizedApiKey).trim()}`);
  } else {
    lines.push("  # api_key: local-dev-key");
  }

  lines.push(
    "",
    "# Allowed AI backends and their launch commands.",
    "allow_cli_list:",
    "  codex: codex",
    "  kimi: kimi",
    "  claude: claude",
    "  opencode: opencode",
    "",
    "# Optional extra environment variables for AI SDK / backend CLIs.",
    "# envs:",
    "#   http_proxy: http://127.0.0.1:7890",
    "#   https_proxy: http://127.0.0.1:7890",
    "#   AISDK_PROVIDER_PATH: /abs/path/to/provider.js",
    "",
  );

  return lines.join("\n");
}

export function writeServeAiConfigFile(targetPath, options = {}) {
  const normalizedPath = path.resolve(String(targetPath || "").trim());
  if (!normalizedPath) {
    throw new Error("targetPath is required");
  }
  fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  fs.writeFileSync(normalizedPath, buildServeAiConfigYaml(options), "utf8");
  return normalizedPath;
}
