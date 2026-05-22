#!/usr/bin/env node

/**
 * conductor update - Check for and install updates to the CLI.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import process from "node:process";
import readline from "node:readline/promises";
import {
  PACKAGE_NAME,
  buildUpgradeCommand,
  resolveInstallMethod,
  fetchLatestVersion,
  isNewerVersion,
  detectPackageManager,
} from "../src/version-check.js";
import {
  buildPnpmAllowBuildArgs,
  ensurePnpmOnlyBuiltDependencies,
  repairAndVerifyGlobalNodePty,
} from "../src/native-deps.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.join(__dirname, "..");

const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf-8"));
const CURRENT_VERSION = pkgJson.version;
const INSTALL_METHOD = resolveInstallMethod({
  env: process.env,
  packageRoot: PKG_ROOT,
});

// ANSI 颜色代码
const COLORS = {
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  bold: "\x1b[1m"
};

function colorize(text, color) {
  return `${COLORS[color] || ""}${text}${COLORS.reset}`;
}

async function main() {
  // 解析命令行参数
  const args = process.argv.slice(2);
  const forceUpdate = args.includes("--force") || args.includes("-f");
  const skipConfirm = args.includes("--yes") || args.includes("-y");
  const showHelp = args.includes("--help") || args.includes("-h");

  if (showHelp) {
    showHelpMessage();
    process.exit(0);
  }

  if (INSTALL_METHOD === "homebrew") {
    console.log(colorize("🍺 Homebrew-managed install detected", "cyan"));
    console.log("");
    console.log(`   Use ${colorize(buildUpgradeCommand({ env: process.env }), "green")} to upgrade conductor.`);
    process.exit(0);
  }

  console.log(colorize(`📦 ${PACKAGE_NAME}`, "cyan"));
  console.log(`   Current version: ${CURRENT_VERSION}`);
  console.log("");

  // 检查远程最新版本
  console.log("🔍 Checking for updates...");
  
  let latestVersion;
  try {
    latestVersion = await getLatestVersion();
  } catch (error) {
    console.error(colorize(`❌ Failed to check for updates: ${error.message}`, "red"));
    process.exit(1);
  }

  console.log(`   Latest version:  ${latestVersion}`);
  console.log("");

  // 比较版本
  if (!forceUpdate && !isNewerVersion(latestVersion, CURRENT_VERSION)) {
    console.log(colorize("✅ You are already on the latest version!", "green"));
    process.exit(0);
  }

  if (forceUpdate) {
    console.log(colorize("⚡ Force update requested", "yellow"));
  } else {
    console.log(colorize(`⬆️  Update available: ${CURRENT_VERSION} → ${latestVersion}`, "green"));
  }

  console.log("");

  // 确认更新
  if (!skipConfirm) {
    const shouldUpdate = await confirmUpdate(latestVersion);
    if (!shouldUpdate) {
      console.log("Update cancelled.");
      process.exit(0);
    }
  }

  // 执行更新
  console.log("");
  console.log(colorize("🚀 Installing update...", "cyan"));
  console.log("");

  try {
    await performUpdate();
    console.log("");
    console.log(colorize("✅ Update completed successfully!", "green"));
    console.log("");
    console.log("   Run 'conductor --version' to verify the new version.");
  } catch (error) {
    console.error("");
    console.error(colorize(`❌ Update failed: ${error.message}`, "red"));
    console.error("");
    console.error("   You can try updating manually with:");
    console.error(`   npm install -g ${PACKAGE_NAME}@latest`);
    process.exit(1);
  }
}

async function getLatestVersion() {
  const version = await fetchLatestVersion();
  if (!version) {
    throw new Error("Could not fetch latest version from npm registry");
  }
  return version;
}

async function confirmUpdate(version) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  try {
    const answer = await rl.question(
      colorize(`Do you want to update to version ${version}? (Y/n): `, "yellow")
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === "" || normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

async function performUpdate() {
  const packageManager = detectPackageManager({
    launcherPath: process.env.CONDUCTOR_LAUNCHER_SCRIPT || process.argv[1],
    packageRoot: PKG_ROOT,
  });
  console.log(`   Using package manager: ${colorize(packageManager, "cyan")}`);
  console.log("");

  if (packageManager === "pnpm") {
    console.log("   Preparing pnpm native dependency allowlist...");
    await ensurePnpmOnlyBuiltDependencies({
      runCommand: runBufferedCommand,
      dependencies: ["node-pty"],
      global: true,
    });
    console.log("");
  }

  let cmd, args;

  switch (packageManager) {
    case "pnpm":
      cmd = "pnpm";
      args = ["add", "-g", ...buildPnpmAllowBuildArgs(["node-pty"]), `${PACKAGE_NAME}@latest`];
      break;
    case "yarn":
      cmd = "yarn";
      args = ["global", "add", `${PACKAGE_NAME}@latest`];
      break;
    case "npm":
    default:
      cmd = "npm";
      args = ["install", "-g", `${PACKAGE_NAME}@latest`];
      break;
  }

  console.log(`   Running: ${colorize(`${cmd} ${args.join(" ")}`, "cyan")}`);
  console.log("");

  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: true
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Exit code ${code}`));
      }
    });

    child.on("error", (error) => {
      reject(error);
    });
  });

  console.log("   Repairing and verifying node-pty native binding...");
  await repairAndVerifyGlobalNodePty({
    packageManager,
    packageName: PACKAGE_NAME,
    runCommand: runBufferedCommand,
    nodeExecutable: process.execPath,
  });
}

function runBufferedCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: options.env || process.env,
      cwd: options.cwd || process.cwd(),
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore timeout failures
      }
    }, options.timeoutMs || 20_000);

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 16_000) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 16_000) stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ success: code === 0, code, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        success: false,
        code: -1,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

function showHelpMessage() {
  console.log(`conductor update - Update the CLI to the latest version

Usage: conductor update [options]

Options:
  -f, --force    Force update even if already on latest version
  -y, --yes      Skip confirmation prompt
  -h, --help     Show this help message

Examples:
  conductor update          Check for updates and prompt to install
  conductor update --yes    Update without prompting
  conductor update --force  Force reinstall the latest version
`);
}

main().catch((error) => {
  console.error(colorize(`Unexpected error: ${error?.message || error}`, "red"));
  process.exit(1);
});
