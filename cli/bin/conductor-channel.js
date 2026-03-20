#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { loadConfig } from "@love-moon/conductor-sdk";

const isMainModule = (() => {
  const currentFile = fileURLToPath(import.meta.url);
  const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return entryFile === currentFile;
})();

function resolveDefaultConfigPath(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, ".conductor", "config.yaml");
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function ensureFeishuChannelConfig(config) {
  const feishu = config?.channels?.feishu;
  if (!feishu?.appId || !feishu?.appSecret || !feishu?.verificationToken) {
    throw new Error("config.yaml is missing channels.feishu.app_id/app_secret/verification_token");
  }
  return feishu;
}

function formatErrorBody(text) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized) return "";
  try {
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // ignore
  }
  return normalized;
}

export async function connectFeishuChannel(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? global.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available");
  }

  const resolvedConfigPath = path.resolve(options.configFile || resolveDefaultConfigPath(env));
  const rawYaml = readTextFile(resolvedConfigPath);
  const config = loadConfig(resolvedConfigPath, { env });
  const feishu = ensureFeishuChannelConfig(config);

  const url = new URL("/api/channel/feishu/config", config.backendUrl);
  const response = await fetchImpl(String(url), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.agentToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ yaml: rawYaml }),
  });

  const rawText = await response.text();
  if (!response.ok) {
    const detail = formatErrorBody(rawText);
    throw new Error(`Failed to connect Feishu channel (${response.status})${detail ? `: ${detail}` : ""}`);
  }

  const parsed = rawText ? JSON.parse(rawText) : {};
  return {
    configPath: resolvedConfigPath,
    feishu,
    config: parsed.config ?? null,
  };
}

export async function main(argvInput = hideBin(process.argv), dependencies = {}) {
  const log = dependencies.log ?? console.log;
  const logError = dependencies.logError ?? console.error;

  await yargs(argvInput)
    .scriptName("conductor channel")
    .command(
      "connect feishu",
      "Upload channels.feishu from config.yaml to Conductor backend",
      (command) => command.option("config-file", {
        type: "string",
        describe: "Path to Conductor config file",
      }),
      async (argv) => {
        try {
          const result = await connectFeishuChannel({
            configFile: argv.configFile,
          });
          const effective = result.config ?? {
            provider: "FEISHU",
            appId: result.feishu.appId,
            verificationToken: result.feishu.verificationToken,
          };
          log(`Connected Feishu channel from ${result.configPath}`);
          log(`app_id: ${effective.appId}`);
          log(`verification_token: ${effective.verificationToken}`);
          log("Configure the same verification_token in Feishu Open Platform webhook settings.");
        } catch (error) {
          logError(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        }
      },
    )
    .demandCommand(1)
    .help()
    .parseAsync();
}

if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
