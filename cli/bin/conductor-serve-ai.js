#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import { startServeAiServer } from "../src/serve-ai/index.js";
import {
  resolveServeAiConfigPaths,
  writeServeAiConfigFile,
} from "../src/serve-ai/config.js";

const CLI_NAME = process.env.CONDUCTOR_CLI_NAME || "conductor serve-ai";

main().catch((error) => {
  process.stderr.write(`serve-ai failed: ${error?.message || error}\n`);
  process.exit(1);
});

async function main() {
  await yargs(hideBin(process.argv))
    .scriptName(CLI_NAME)
    .command(
      "$0",
      "Start an OpenAI-compatible AI server",
      (cmd) =>
        cmd
          .option("host", {
            type: "string",
            default: process.env.CONDUCTOR_SERVE_AI_HOST || undefined,
            describe: "Host interface to bind",
          })
          .option("port", {
            type: "number",
            default: process.env.CONDUCTOR_SERVE_AI_PORT ? Number(process.env.CONDUCTOR_SERVE_AI_PORT) : undefined,
            describe: "TCP port to bind",
          })
          .option("backend", {
            type: "string",
            describe: "Default backend/model to use when request model is omitted",
          })
          .option("config-file", {
            type: "string",
            describe: "Primary Conductor config path to check before falling back",
          })
          .option("api-key", {
            type: "string",
            describe: "Optional API key to require via Authorization: Bearer <key>",
          })
          .example("$0", "Start an OpenAI-compatible server using config.yaml or config-ai-serve.yaml")
          .example("$0 --backend kimi --port 9000", "Use kimi as default backend and listen on port 9000")
          .example("$0 --api-key local-dev-key", "Require Bearer local-dev-key"),
      async (args) => {
        const server = await startServeAiServer({
          host: args.host,
          port: args.port,
          backend: args.backend,
          configFile: args.configFile,
          apiKey: args.apiKey,
        });

        process.stdout.write(
          `OpenAI-compatible server listening at ${server.url} (default model: ${args.backend || "auto"})\n`,
        );
        process.stdout.write(
          `Config source: ${server.configSource} (${server.configPath})\n`,
        );

        const shutdown = async () => {
          process.stdout.write("Shutting down serve-ai server\n");
          await server.close().catch(() => {});
          process.exit(0);
        };

        process.on("SIGINT", () => {
          void shutdown();
        });
        process.on("SIGTERM", () => {
          void shutdown();
        });

        await new Promise(() => {});
      },
    )
    .command(
      "init",
      "Create a dedicated config-ai-serve.yaml next to the primary config path",
      (cmd) =>
        cmd
          .option("config-file", {
            type: "string",
            describe: "Primary Conductor config path whose directory will host config-ai-serve.yaml",
          })
          .option("backend", {
            type: "string",
            default: "codex",
            describe: "Default backend to write into serve_ai.backend",
          })
          .option("host", {
            type: "string",
            default: "127.0.0.1",
            describe: "Default host to write into serve_ai.host",
          })
          .option("port", {
            type: "number",
            default: 8787,
            describe: "Default port to write into serve_ai.port",
          })
          .option("api-key", {
            type: "string",
            describe: "Optional default API key to write into serve_ai.api_key",
          })
          .option("force", {
            type: "boolean",
            default: false,
            describe: "Overwrite an existing config-ai-serve.yaml",
          })
          .example("$0 init", "Create ~/.conductor/config-ai-serve.yaml")
          .example("$0 init --config-file /tmp/custom/config.yaml", "Create /tmp/custom/config-ai-serve.yaml"),
      async (args) => {
        const { conductorConfigPath, serveAiConfigPath } = resolveServeAiConfigPaths(args.configFile);
        if (fs.existsSync(serveAiConfigPath) && !args.force) {
          throw new Error(
            `serve-ai config already exists at ${serveAiConfigPath}. Use --force to overwrite it.`,
          );
        }

        writeServeAiConfigFile(serveAiConfigPath, {
          backend: args.backend,
          host: args.host,
          port: args.port,
          apiKey: args.apiKey,
        });

        process.stdout.write(`Primary config path: ${conductorConfigPath}\n`);
        process.stdout.write(`Created serve-ai config: ${serveAiConfigPath}\n`);
      },
    )
    .demandCommand(1, "")
    .help()
    .strict()
    .parseAsync();
}
