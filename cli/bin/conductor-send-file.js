#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { ConductorConfig, loadConfig } from "@love-moon/conductor-sdk";
import { envForExplicitConfigFile } from "../src/config-env.js";
import { resolveConductorConfigPath } from "../src/conductor-paths.js";

const DEFAULT_MIME_TYPE = "application/octet-stream";
const FIRE_TASK_MARKER_PREFIX = "active-fire";

const EXTENSION_TO_MIME = {
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

const isMainModule = (() => {
  const currentFile = fileURLToPath(import.meta.url);
  const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return entryFile === currentFile;
})();

function walkUpDirectories(startDir) {
  const visited = [];
  let currentDir = path.resolve(startDir);
  while (true) {
    visited.push(currentDir);
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }
  return visited;
}

function normalizeTaskId(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function pickLatestTaskIdFromStateDir(stateDir) {
  if (!fs.existsSync(stateDir)) {
    return "";
  }

  const matches = [];
  for (const entry of fs.readdirSync(stateDir)) {
    const match = entry.match(new RegExp(`^${FIRE_TASK_MARKER_PREFIX}\\.task_([0-9a-f-]+)\\.json$`, "i"));
    if (!match) {
      continue;
    }
    const filePath = path.join(stateDir, entry);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    matches.push({ taskId: match[1], mtimeMs });
  }

  if (matches.length === 0) {
    return "";
  }

  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return matches[0].taskId;
}

export function detectTaskId(options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();

  const envTaskId = normalizeTaskId(env.CONDUCTOR_TASK_ID);
  if (envTaskId) {
    return envTaskId;
  }

  for (const directory of walkUpDirectories(cwd)) {
    const stateTaskId = pickLatestTaskIdFromStateDir(path.join(directory, ".conductor", "state"));
    if (stateTaskId) {
      return stateTaskId;
    }
  }

  return "";
}

function loadCliConfig(configFile, env = process.env) {
  const configPath = resolveConductorConfigPath(configFile, env);
  const configEnv = envForExplicitConfigFile(configFile, env);
  if (fs.existsSync(configPath)) {
    return loadConfig(configPath, { env: configEnv });
  }

  const agentToken = typeof env.CONDUCTOR_AGENT_TOKEN === "string" ? env.CONDUCTOR_AGENT_TOKEN.trim() : "";
  const backendUrl = typeof env.CONDUCTOR_BACKEND_URL === "string" ? env.CONDUCTOR_BACKEND_URL.trim() : "";
  if (agentToken && backendUrl) {
    return new ConductorConfig({
      agentToken,
      backendUrl,
    });
  }

  return loadConfig(configPath, { env: configEnv });
}

export function guessMimeType(fileName, preferredMimeType = "") {
  const preferred = typeof preferredMimeType === "string" ? preferredMimeType.trim() : "";
  if (preferred) {
    return preferred;
  }
  const extension = path.extname(fileName).toLowerCase();
  return EXTENSION_TO_MIME[extension] || DEFAULT_MIME_TYPE;
}

function formatErrorBody(text) {
  const normalized = text.trim();
  if (!normalized) {
    return "";
  }
  try {
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // ignore parse failures
  }
  return normalized;
}

export async function sendFileToTask(options) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available");
  }

  const taskId = normalizeTaskId(options.taskId) || detectTaskId({ env, cwd });
  if (!taskId) {
    throw new Error("Unable to resolve task ID. Pass --task-id or run inside an active Conductor fire workspace.");
  }

  const config = loadCliConfig(options.configFile, env);
  const filePath = path.resolve(cwd, String(options.filePath || ""));
  const stats = await fsp.stat(filePath).catch(() => null);
  if (!stats || !stats.isFile()) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileBuffer = await fsp.readFile(filePath);
  const fileName =
    typeof options.name === "string" && options.name.trim()
      ? path.basename(options.name.trim())
      : path.basename(filePath);
  const mimeType = guessMimeType(fileName, options.mimeType);
  const body = new FormData();
  body.set("file", new Blob([fileBuffer], { type: mimeType }), fileName);

  const content = typeof options.content === "string" ? options.content.trim() : "";
  if (content) {
    body.set("content", content);
  }

  const role = typeof options.role === "string" && options.role.trim()
    ? options.role.trim().toLowerCase()
    : "sdk";
  body.set("role", role);

  const url = new URL(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, config.backendUrl);
  const response = await fetchImpl(String(url), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.agentToken}`,
      Accept: "application/json",
    },
    body,
  });

  const rawText = await response.text();
  if (!response.ok) {
    const details = formatErrorBody(rawText);
    throw new Error(`Upload failed (${response.status})${details ? `: ${details}` : ""}`);
  }

  return {
    taskId,
    response: rawText ? JSON.parse(rawText) : {},
  };
}

export async function main(argvInput = hideBin(process.argv)) {
  await yargs(argvInput)
    .scriptName("conductor send-file")
    .command(
      "$0 <file>",
      "Upload a local file into the task session",
      (command) => command
        .positional("file", {
          describe: "Path to the local file to upload into the task session",
          type: "string",
          demandOption: true,
        })
        .option("task-id", {
          type: "string",
          describe: "Explicit Conductor task ID. Defaults to auto-detecting the current task.",
        })
        .option("config-file", {
          type: "string",
          describe: "Path to Conductor config file",
        })
        .option("content", {
          alias: "m",
          type: "string",
          describe: "Optional message text to accompany the uploaded file",
        })
        .option("role", {
          choices: ["sdk", "assistant", "user"],
          default: "sdk",
          describe: "Message role to write into the task session",
        })
        .option("mime-type", {
          type: "string",
          describe: "Override MIME type detection",
        })
        .option("name", {
          type: "string",
          describe: "Override the filename shown in Conductor",
        })
        .option("json", {
          type: "boolean",
          default: false,
          describe: "Print the raw JSON response",
        }),
      async (argv) => {
        const result = await sendFileToTask({
          filePath: argv.file,
          taskId: argv.taskId,
          configFile: argv.configFile,
          content: argv.content,
          role: argv.role,
          mimeType: argv.mimeType,
          name: argv.name,
        });

        if (argv.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          return;
        }

        const attachments = Array.isArray(result.response?.attachments) ? result.response.attachments : [];
        const attachmentNames = attachments.map((attachment) => attachment?.name).filter(Boolean);
        const summary = attachmentNames.length > 0 ? attachmentNames.join(", ") : path.basename(String(argv.file));
        process.stdout.write(`Uploaded ${summary} to task ${result.taskId}\n`);
      },
    )
    .help()
    .strict()
    .parse();
}

if (isMainModule) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
