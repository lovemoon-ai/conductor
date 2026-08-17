#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { execFileSync, execSync } from "node:child_process";
import { createRequire } from "node:module";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import { RUNTIME_SUPPORTED_BACKENDS } from "../src/runtime-backends.js";
import { resolveConductorConfigPath } from "../src/conductor-paths.js";

const CONFIG_FILE = resolveConductorConfigPath();
const CONFIG_DIR = path.dirname(CONFIG_FILE);
const packageJson = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);

const DEFAULT_CLIs = {
  claude: {
    command: "claude",
    execArgs: "--dangerously-skip-permissions",
    description: "Anthropic Claude CLI"
  },
  codex: {
    command: "codex",
    execArgs: "--dangerously-bypass-approvals-and-sandbox --ask-for-approval never",
    description: "OpenAI Codex CLI"
  },
  kimi: {
    command: "kimi",
    execArgs: "",
    description: "Moonshot Kimi CLI"
  },
  opencode: {
    command: "opencode",
    execArgs: "",
    description: "OpenCode CLI (Conductor runs opencode serve with permission=allow)"
  },
  copilot: {
    command: "copilot",
    execArgs: "",
    description: "GitHub Copilot (built in via SDK)"
  },
  dsh: {
    command: "dsh",
    execArgs: "",
    description: "DeepSeek Harness agent (built in via SDK; needs DEEPSEEK_API_KEY)"
  },
  // chat-web is the runtime backend (an in-process Chromium driver, not a CLI
  // binary). It has multiple sub-providers selected via --model. Each user-
  // facing alias below resolves to the chat-web runtime; advertising the bare
  // `chat-web` backend would be ambiguous, so we emit two explicit aliases.
  "web-chatgpt": {
    command: "chat-web",
    execArgs: "--model chatgpt",
    description: "Chat web (ChatGPT) via @love-moon/chat-web",
    runtimeBackend: "chat-web"
  },
  "web-gemini": {
    command: "chat-web",
    execArgs: "--model gemini",
    description: "Chat web (Google AI Studio / Gemini) via @love-moon/chat-web",
    runtimeBackend: "chat-web"
  },
};

const backendUrl =
  process.env.CONDUCTOR_BACKEND_URL ||
  process.env.BACKEND_URL ||
  "https://conductor.conductor-ai.top";
const defaultDaemonName = os.hostname() || "my-daemon";
const cliVersion = packageJson.version || "unknown";
const OPENCODE_INSTALL_URL = "https://opencode.ai/install";
const OPENCODE_NPM_PACKAGE = "opencode-ai";
const LEGACY_CONDUCTOR_PUBLIC_HOST = "conductor-ai.top";
const CONDUCTOR_PUBLIC_HOST = "conductor.conductor-ai.top";
const CONDUCTOR_PUBLIC_ORIGIN = "https://conductor.conductor-ai.top";

const COLORS = {
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
  bold: "\x1b[1m"
};

let lastDeviceAuthConfig = null;
let promptInterface = null;

function colorize(text, color) {
  return `${COLORS[color] || ""}${text}${COLORS.reset}`;
}

function isBuiltInCopilotAvailable() {
  return Boolean(
    packageJson?.dependencies?.["@github/copilot-sdk"] ||
    packageJson?.optionalDependencies?.["@github/copilot-sdk"],
  );
}

function isBuiltInChatWebAvailable() {
  return Boolean(
    packageJson?.dependencies?.["@love-moon/chat-web"] ||
    packageJson?.optionalDependencies?.["@love-moon/chat-web"],
  );
}

function isBuiltInDshAvailable() {
  // The dsh runtime ships as pinned dependencies of @love-moon/ai-sdk (not of
  // the CLI itself), so resolve it THROUGH ai-sdk's resolution context — a
  // direct resolve from cli/bin fails under pnpm's isolated node_modules.
  try {
    const require = createRequire(import.meta.url);
    const aiSdkEntry = require.resolve("@love-moon/ai-sdk");
    createRequire(aiSdkEntry).resolve("@deepseek-ai/dsh-sdk-jsonrpc-demo/bin");
    return true;
  } catch {
    return false;
  }
}

function buildConfigEntryLines(cli, info, { commented = false } = {}) {
  const fullCommand = info.execArgs
    ? `${info.command} ${info.execArgs}`
    : info.command;
  const entryPrefix = commented ? "  # " : "  ";
  const commentPrefix = commented ? "  # " : "  # ";
  const lines = [];

  if (cli === "opencode") {
    lines.push(`${commentPrefix}opencode runs via ai-sdk server mode with permission=allow`);
  }
  if (cli === "web-chatgpt") {
    // web-chatgpt / web-gemini both resolve to the chat-web runtime backend
    // (an in-process Chromium driver via @love-moon/chat-web). The command
    // line is not executed; CLI parses --model from it.
    lines.push(`${commentPrefix}web-chatgpt / web-gemini drive a real Chromium browser via @love-moon/chat-web`);
  }

  lines.push(`${entryPrefix}${cli}: ${fullCommand}`);
  return lines;
}

function getPromptInterface() {
  if (!promptInterface) {
    promptInterface = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return promptInterface;
}

function closePromptInterface() {
  if (!promptInterface) {
    return;
  }
  promptInterface.close();
  promptInterface = null;
}

function exitWithCode(code) {
  closePromptInterface();
  process.exit(code);
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option("token", {
      type: "string",
      description: "Conductor token"
    })
    .option("manual", {
      type: "boolean",
      default: false,
      description: "Enter token manually instead of browser device authorization"
    })
    .option("force", {
      type: "boolean",
      default: false,
      description: "Overwrite existing config file"
    })
    .option("help", {
      type: "boolean",
      alias: "h",
      description: "Show help"
    })
    .usage("Usage: conductor config [options]")
    .example("conductor config", "Authorize this device in the browser and write config")
    .example("conductor config --manual", "Enter token manually")
    .example("conductor config --token <token>", "Configure with token")
    .example("conductor config --token <token> --force", "Force overwrite existing config")
    .help()
    .argv;

  if (fs.existsSync(CONFIG_FILE) && !argv.force) {
    process.stderr.write(
      colorize(`Config already exists at ${CONFIG_FILE}. Use --force to overwrite.\n`, "yellow")
    );
    exitWithCode(1);
  }

  let resolvedBackendUrl = backendUrl;
  let resolvedWebsocketUrl = null;
  let detectedCLIs = detectInstalledCLIs();

  if (detectedCLIs.length === 0) {
    console.log("");
    console.log(colorize("=".repeat(70), "yellow"));
    console.log(colorize("⚠️  WARNING: No coding CLI detected!", "yellow"));
    console.log(colorize("=".repeat(70), "yellow"));
    console.log("");
    console.log(colorize("Conductor requires at least one coding CLI to work properly.", "yellow"));
    console.log("");
    console.log(colorize("Please install one of the following CLIs first:", "yellow"));
    console.log("");

    Object.entries(DEFAULT_CLIs).forEach(([, info]) => {
      console.log(`  • ${colorize(info.command, "cyan")} - ${info.description}`);
    });

    console.log("");
    const shouldInstallOpencode = await promptYesNo(
      "Do you want to install opencode now? (Y/n): ",
      { defaultValue: true }
    );

    if (shouldInstallOpencode) {
      const installResult = installOpencode();
      if (installResult.installed) {
        detectedCLIs = detectInstalledCLIs();
        if (!detectedCLIs.includes("opencode")) {
          detectedCLIs = ["opencode", ...detectedCLIs];
        }
        console.log("");
        if (installResult.message) {
          console.log(colorize(installResult.message, "green"));
        }
        console.log(colorize("✓ OpenCode installed. Continuing with conductor config.", "green"));
        console.log("");
      } else {
        console.log("");
        console.log(colorize(installResult.message, "yellow"));
        console.log("");
      }
    }

    if (detectedCLIs.length === 0) {
      console.log(colorize("After installing a CLI, run 'conductor config' again.", "yellow"));
      console.log(colorize("=".repeat(70), "yellow"));
      console.log("");

      const shouldContinue = await promptYesNo(
        "Do you want to continue creating the config anyway? (y/N): "
      );

      if (!shouldContinue) {
        exitWithCode(1);
      }
    }
  } else {
    console.log("");
    console.log(colorize("✓ Detected the following coding CLIs:", "green"));
    detectedCLIs.forEach((cli) => {
      const info = DEFAULT_CLIs[cli];
      // Display the alias name (key) so backends like web-chatgpt and
      // web-gemini that share the chat-web runtime are not collapsed to a
      // single duplicate "chat-web" line.
      console.log(`  • ${colorize(cli, "cyan")} - ${info.description}`);
    });
    console.log("");
  }

  let token = argv.token;
  if (!token) {
    if (argv.manual) {
      token = await promptForToken();
      if (!token) {
        process.stderr.write(colorize("No token provided. Aborting.\n", "yellow"));
        exitWithCode(1);
      }
    } else {
      const authResult = await authorizeDeviceAndGetToken();
      token = authResult.agentToken;
      resolvedBackendUrl = authResult.backendUrl || resolvedBackendUrl;
      resolvedWebsocketUrl = authResult.websocketUrl || null;
    }
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const lines = [
    `agent_token: ${yamlQuote(token)}`,
    `backend_url: ${yamlQuote(resolvedBackendUrl)}`,
    `daemon_name: ${yamlQuote(defaultDaemonName)}`,
    "log_level: debug",
    "workspace: '~/ws/fires'",
    "",
    "# Allowed coding CLIs",
    "allow_cli_list:"
  ];

  if (resolvedWebsocketUrl) {
    lines.splice(2, 0, `websocket_url: ${yamlQuote(resolvedWebsocketUrl)}`);
  }

  if (detectedCLIs.length > 0) {
    detectedCLIs.forEach((cli) => {
      const info = DEFAULT_CLIs[cli];
      lines.push(...buildConfigEntryLines(cli, info));
    });
  } else {
    lines.push("  # No CLI detected. Add your installed CLI here:");
    Object.entries(DEFAULT_CLIs).forEach(([key, info]) => {
      lines.push(...buildConfigEntryLines(key, info, { commented: true }));
    });
  }

  lines.push(
    "",
    "# Uncomment to use custom envs, such as proxy.",
    "# envs:",
    "#   http_proxy: http://127.0.0.1:7890",
    "#   https_proxy: http://127.0.0.1:7890",
    "#   all_proxy: socks5://127.0.0.1:7890",
    "#   AISDK_PROVIDER_PATH: path-to-private-aisdk-provider.js"
  );

  fs.writeFileSync(CONFIG_FILE, lines.join("\n"), "utf-8");

  console.log(colorize(`✓ Wrote Conductor config to ${CONFIG_FILE}`, "green"));

  if (detectedCLIs.length === 0) {
    console.log("");
    console.log(colorize("⚠️  Remember to install a coding CLI before using Conductor!", "yellow"));
  }
}

function detectInstalledCLIs() {
  const detected = [];

  for (const [key, info] of Object.entries(DEFAULT_CLIs)) {
    const runtimeBackend = info.runtimeBackend || key;
    if (!RUNTIME_SUPPORTED_BACKENDS.includes(runtimeBackend)) {
      continue;
    }
    if (runtimeBackend === "copilot" && isBuiltInCopilotAvailable()) {
      detected.push(key);
      continue;
    }
    if (runtimeBackend === "chat-web" && isBuiltInChatWebAvailable()) {
      detected.push(key);
      continue;
    }
    if (runtimeBackend === "dsh" && isBuiltInDshAvailable()) {
      detected.push(key);
      continue;
    }
    if (isCommandAvailable(info.command)) {
      detected.push(key);
    }
  }

  return detected;
}

function resolveBundledCommandPath(command) {
  const binDir = path.dirname(process.execPath);
  const candidates = os.platform() === "win32"
    ? [`${command}.cmd`, `${command}.exe`, command]
    : [command];

  for (const candidate of candidates) {
    const fullPath = path.join(binDir, candidate);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  return null;
}

function isCommandAvailable(command) {
  try {
    const platform = os.platform();
    const checkCmd = platform === "win32" ? `where ${command}` : `command -v ${command}`;
    execSync(checkCmd, {
      stdio: "pipe",
      timeout: 5000
    });
    return true;
  } catch {
    return checkAlternativeInstallations(command);
  }
}

function checkAlternativeInstallations(command) {
  const homeDir = os.homedir();
  const platform = os.platform();
  const commonPaths = [];

  if (platform === "win32") {
    commonPaths.push(
      path.join(homeDir, "AppData", "Roaming", "npm", `${command}.cmd`),
      path.join(homeDir, "AppData", "Local", "Programs", command, `${command}.exe`),
      path.join("C:", "Program Files", command, `${command}.exe`),
      path.join("C:", "Program Files (x86)", command, `${command}.exe`)
    );
  } else {
    commonPaths.push(
      `/usr/local/bin/${command}`,
      `/opt/homebrew/bin/${command}`,
      `/usr/bin/${command}`,
      path.join(homeDir, ".local", "bin", command),
      path.join(homeDir, ".cargo", "bin", command),
      path.join(homeDir, ".npm-global", "bin", command),
      `/opt/${command}/bin/${command}`
    );
  }

  return commonPaths.some((checkPath) => fs.existsSync(checkPath));
}

function resolveInstallCommand(command) {
  const bundledPath = resolveBundledCommandPath(command);
  if (bundledPath) {
    return bundledPath;
  }
  return isCommandAvailable(command) ? command : null;
}

function resolveOpencodeInstaller() {
  const overrideCommand = process.env.CONDUCTOR_OPENCODE_INSTALL_COMMAND?.trim();
  if (overrideCommand) {
    return {
      command: overrideCommand,
      args: [],
      display: overrideCommand,
    };
  }

  const npmCommand = resolveInstallCommand("npm");
  if (npmCommand) {
    return {
      command: npmCommand,
      args: ["install", "-g", OPENCODE_NPM_PACKAGE],
      display: `${path.basename(npmCommand)} install -g ${OPENCODE_NPM_PACKAGE}`,
    };
  }

  const pnpmCommand = resolveInstallCommand("pnpm");
  if (pnpmCommand) {
    return {
      command: pnpmCommand,
      args: ["install", "-g", OPENCODE_NPM_PACKAGE],
      display: `${path.basename(pnpmCommand)} install -g ${OPENCODE_NPM_PACKAGE}`,
    };
  }

  const bunCommand = resolveInstallCommand("bun");
  if (bunCommand) {
    return {
      command: bunCommand,
      args: ["install", "-g", OPENCODE_NPM_PACKAGE],
      display: `${path.basename(bunCommand)} install -g ${OPENCODE_NPM_PACKAGE}`,
    };
  }

  if (os.platform() !== "win32" && isCommandAvailable("bash") && isCommandAvailable("curl")) {
    return {
      command: "bash",
      args: ["-lc", `curl -fsSL ${OPENCODE_INSTALL_URL} | bash`],
      display: `curl -fsSL ${OPENCODE_INSTALL_URL} | bash`,
    };
  }

  return null;
}

function printOpencodeInstallInstructions() {
  console.log(colorize("You can install OpenCode manually with one of these commands:", "yellow"));
  console.log(`  curl -fsSL ${OPENCODE_INSTALL_URL} | bash`);
  console.log(`  npm install -g ${OPENCODE_NPM_PACKAGE}`);
}

function installOpencode() {
  const installer = resolveOpencodeInstaller();
  if (!installer) {
    printOpencodeInstallInstructions();
    return {
      installed: false,
      message: "Could not find an automatic installer for opencode in the current environment.",
    };
  }

  console.log("");
  console.log(colorize(`Installing opencode with: ${installer.display}`, "cyan"));
  console.log("");

  try {
    execFileSync(installer.command, installer.args, {
      stdio: "inherit",
      env: process.env,
    });
  } catch (error) {
    printOpencodeInstallInstructions();
    return {
      installed: false,
      message: `opencode installation failed: ${error?.message || error}`,
    };
  }

  if (isCommandAvailable("opencode")) {
    return {
      installed: true,
      message: "OpenCode installed successfully.",
    };
  }

  return {
    installed: true,
    message: "OpenCode installed, but the current shell may need a refreshed PATH before detection works.",
  };
}

async function authorizeDeviceAndGetToken() {
  const startResponse = await fetch(new URL("/api/auth/device/start", backendUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cli_version: cliVersion,
      hostname: defaultDaemonName,
      platform: os.platform(),
      backend_url: backendUrl,
    }),
  });
  const startData = await parseJsonResponse(startResponse);
  if (!startResponse.ok) {
    throw new Error(startData.error || `Failed to start device authorization (${startResponse.status})`);
  }

  console.log("");
  console.log(colorize("Open this link in your browser to authorize this device:", "cyan"));
  console.log("");
  console.log(`Device code: ${colorize(startData.user_code, "bold")}`);
  console.log(
    `Direct link: ${normalizeOfficialConductorUrl(startData.verification_uri_complete, backendUrl)}`,
  );
  console.log("");
  console.log("Only approve the request if the web page shows the same device code.");
  console.log("");
  console.log("Waiting for authorization...");

  const intervalSeconds =
    typeof startData.interval === "number" && Number.isFinite(startData.interval)
      ? Math.max(1, startData.interval)
      : 3;
  const expiresInSeconds =
    typeof startData.expires_in === "number" && Number.isFinite(startData.expires_in)
      ? Math.max(intervalSeconds, startData.expires_in)
      : 600;
  const deadlineAt = Date.now() + expiresInSeconds * 1000;

  while (Date.now() <= deadlineAt) {
    await sleep(intervalSeconds * 1000);

    const pollResponse = await fetch(new URL("/api/auth/device/poll", backendUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: startData.device_code }),
    });
    const pollData = await parseJsonResponse(pollResponse);
    if (!pollResponse.ok) {
      throw new Error(pollData.error || `Failed to poll device authorization (${pollResponse.status})`);
    }

    if (pollData.status === "pending") {
      continue;
    }
    if (pollData.status === "approved") {
      const resolvedBackendUrl = normalizeOfficialConductorUrl(
        pollData.backend_url || backendUrl,
        backendUrl,
      );
      const result = {
        agentToken: pollData.agent_token,
        backendUrl: resolvedBackendUrl,
        websocketUrl: normalizeOfficialConductorUrl(
          pollData.websocket_url || null,
          backendUrl,
        ),
      };
      lastDeviceAuthConfig = result;
      console.log(colorize("✓ Device authorized", "green"));
      return result;
    }
    if (pollData.status === "denied" || pollData.status === "expired" || pollData.status === "consumed") {
      throw new Error(pollData.message || `Device authorization ${pollData.status}`);
    }
    if (pollData.error) {
      throw new Error(pollData.error);
    }
  }

  throw new Error("Device authorization timed out");
}

function isOfficialConductorBackend(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  try {
    const hostname = new URL(value).hostname;
    return hostname === LEGACY_CONDUCTOR_PUBLIC_HOST || hostname === CONDUCTOR_PUBLIC_HOST;
  } catch {
    return false;
  }
}

function normalizeOfficialConductorUrl(value, requestBackendUrl) {
  if (typeof value !== "string" || !value.trim()) {
    return value;
  }
  if (!isOfficialConductorBackend(requestBackendUrl)) {
    return value;
  }

  try {
    const parsed = new URL(value);
    if (parsed.hostname !== LEGACY_CONDUCTOR_PUBLIC_HOST) {
      return value;
    }

    const canonicalOrigin = new URL(CONDUCTOR_PUBLIC_ORIGIN);
    parsed.protocol = parsed.protocol === "ws:" || parsed.protocol === "wss:"
      ? "wss:"
      : canonicalOrigin.protocol;
    parsed.host = canonicalOrigin.host;
    return parsed.toString();
  } catch {
    return value;
  }
}

async function parseJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function promptForToken() {
  const rl = getPromptInterface();
  let token = "";
  while (!token) {
    token = (await rl.question("Enter Conductor token: ")).trim();
  }
  return token;
}

async function promptYesNo(question, { defaultValue = false } = {}) {
  const rl = getPromptInterface();
  const answer = (await rl.question(question)).trim().toLowerCase();
  if (!answer) {
    return defaultValue;
  }
  return answer === "y" || answer === "yes";
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function yamlQuote(value) {
  return JSON.stringify(value);
}

main()
  .catch((error) => {
    process.stderr.write(`Failed to write config: ${error?.message || error}\n`);
    exitWithCode(1);
  })
  .finally(() => {
    closePromptInterface();
  });
