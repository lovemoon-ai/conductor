import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn as spawnProcess } from "node:child_process";

function defaultRunCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawnProcess(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env || { ...process.env },
      cwd: options.cwd || process.cwd(),
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore timeout kill failures
      }
    }, options.timeoutMs || 20_000);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 16_000) {
        stdout += chunk.toString();
      }
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 16_000) {
        stderr += chunk.toString();
      }
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

function quoteForSingleQuotedShell(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function shouldIgnoreNodePtyVerificationErrorMessage(message) {
  const normalized = String(message || "")
    .trim()
    .toLowerCase();
  return normalized === "read eio" || normalized.endsWith(": read eio");
}

export function normalizeBuiltDependencyList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value !== "string") {
    return [];
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") {
    return [];
  }
  try {
    return normalizeBuiltDependencyList(JSON.parse(trimmed));
  } catch {
    return trimmed
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
}

export function mergeBuiltDependencies(existing, required) {
  const merged = new Set(normalizeBuiltDependencyList(existing));
  for (const dependency of normalizeBuiltDependencyList(required)) {
    merged.add(dependency);
  }
  return [...merged];
}

export function parsePnpmIgnoredBuildsOutput(value) {
  const ignored = [];
  for (const rawLine of String(value || "").split(/\r?\n/)) {
    const line = rawLine
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .trim();
    if (!line || line.toLowerCase().includes("none")) {
      continue;
    }
    const match = line.match(/^(?:[-*]\s*)?(@?[^@\s][^\s@]*)(?:@[\w.-]+)?$/);
    if (!match) {
      continue;
    }
    const name = match[1].trim();
    if (name && !ignored.includes(name)) {
      ignored.push(name);
    }
  }
  return ignored;
}

export async function detectPnpmIgnoredBuilds({
  runCommand = defaultRunCommand,
  cwd = process.cwd(),
} = {}) {
  const result = await runCommand("pnpm", ["ignored-builds"], { cwd });
  if (!result.success) {
    return [];
  }
  return parsePnpmIgnoredBuildsOutput(result.stdout);
}

export function buildPnpmAllowBuildArgs(dependencies = ["node-pty"]) {
  return normalizeBuiltDependencyList(dependencies).flatMap((dependency) => [
    `--allow-build=${dependency}`,
  ]);
}

export async function ensurePnpmOnlyBuiltDependencies({
  runCommand = defaultRunCommand,
  dependencies = ["node-pty"],
  global = true,
} = {}) {
  const scopeArgs = global ? ["--global"] : ["--location=project"];
  const currentResult = await runCommand("pnpm", [
    "config",
    "get",
    ...scopeArgs,
    "onlyBuiltDependencies",
    "--json",
  ]);
  const current = normalizeBuiltDependencyList(currentResult.stdout);
  const merged = mergeBuiltDependencies(current, dependencies);
  if (merged.length === current.length && merged.every((entry, index) => entry === current[index])) {
    return merged;
  }
  const setResult = await runCommand("pnpm", [
    "config",
    "set",
    ...scopeArgs,
    "onlyBuiltDependencies",
    JSON.stringify(merged),
  ]);
  if (!setResult.success) {
    throw new Error(
      `Failed to configure pnpm onlyBuiltDependencies: ${String(
        setResult.stderr || setResult.stdout || "unknown error",
      ).trim()}`,
    );
  }
  return merged;
}

export async function resolveGlobalPackageDirectory({
  packageManager,
  packageName,
  runCommand = defaultRunCommand,
} = {}) {
  if (!packageManager || !packageName) {
    throw new Error("packageManager and packageName are required");
  }

  let command;
  let args;
  let normalizeRoot = (value) => value;

  if (packageManager === "pnpm" || packageManager === "npm") {
    command = packageManager;
    args = ["root", "-g"];
  } else if (packageManager === "yarn") {
    command = "yarn";
    args = ["global", "dir"];
    normalizeRoot = (value) => path.join(value, "node_modules");
  } else {
    throw new Error(`Unsupported package manager: ${packageManager}`);
  }

  const result = await runCommand(command, args);
  if (!result.success) {
    throw new Error(
      `Failed to resolve global package root via ${packageManager}: ${String(
        result.stderr || result.stdout || "unknown error",
      ).trim()}`,
    );
  }

  const rawRoot = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!rawRoot) {
    throw new Error(`Global package root for ${packageManager} is empty`);
  }

  return path.join(normalizeRoot(rawRoot), packageName);
}

export function ensureNodePtySpawnHelperExecutableForPackageDirectory({
  packageDirectory,
  platform = process.platform,
  arch = process.arch,
  existsSync = fs.existsSync,
  statSync = fs.statSync,
  chmodSync = fs.chmodSync,
} = {}) {
  if (!packageDirectory || platform === "win32") {
    return null;
  }

  const helperCandidates = [
    path.join(packageDirectory, "node_modules", "node-pty", "build", "Release", "spawn-helper"),
    path.join(packageDirectory, "node_modules", "node-pty", "build", "Debug", "spawn-helper"),
    path.join(packageDirectory, "node_modules", "node-pty", "prebuilds", `${platform}-${arch}`, "spawn-helper"),
  ];
  const helperPath = helperCandidates.find((candidate) => existsSync(candidate));
  if (!helperPath) {
    return null;
  }

  const currentMode = statSync(helperPath).mode & 0o777;
  if ((currentMode & 0o111) !== 0) {
    return { helperPath, updated: false };
  }

  const nextMode = currentMode | 0o111;
  chmodSync(helperPath, nextMode);
  return { helperPath, updated: true };
}

export function buildNodePtyVerificationScript() {
  return String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const shouldIgnoreNodePtyVerificationErrorMessage = ${shouldIgnoreNodePtyVerificationErrorMessage.toString()};

const packageDir = process.argv[1];
if (!packageDir) {
  throw new Error('package directory is required');
}
const packageJsonPath = path.join(packageDir, 'package.json');
const req = createRequire(packageJsonPath);
const nodePty = req('node-pty');
const spawn = typeof nodePty.spawn === 'function'
  ? nodePty.spawn
  : (nodePty.default && typeof nodePty.default.spawn === 'function'
      ? nodePty.default.spawn.bind(nodePty.default)
      : null);

if (!spawn) {
  throw new Error('node-pty spawn export not found');
}

const shell = process.platform === 'win32'
  ? (process.env.COMSPEC || 'cmd.exe')
  : (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
const shellArgs = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'exit 0']
  : ['-lc', 'exit 0'];

const child = spawn(shell, shellArgs, {
  name: 'conductor-node-pty-check',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});

let settled = false;
const finish = (code, error) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }
  if (typeof code === 'number' && code !== 0) {
    console.error('node-pty smoke test exited with code ' + code);
    process.exit(1);
    return;
  }
  console.log('Verified node-pty native binding');
  process.exit(0);
};

const timer = setTimeout(() => {
  try {
    child.kill();
  } catch {
    // ignore kill failures
  }
  finish(null, new Error('node-pty smoke test timed out'));
}, 5000);

child.on('exit', (code) => finish(code, null));
child.on('error', (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (shouldIgnoreNodePtyVerificationErrorMessage(message)) {
    return;
  }
  finish(null, error);
});
`;
}

export async function verifyNodePtyForPackageDirectory({
  packageDirectory,
  runCommand = defaultRunCommand,
  nodeExecutable = process.execPath,
} = {}) {
  if (!packageDirectory) {
    throw new Error("packageDirectory is required");
  }
  ensureNodePtySpawnHelperExecutableForPackageDirectory({ packageDirectory });
  const result = await runCommand(nodeExecutable, ["-e", buildNodePtyVerificationScript(), packageDirectory], {
    timeoutMs: 15_000,
  });
  if (!result.success) {
    throw new Error(
      `node-pty verification failed for ${packageDirectory}: ${String(
        result.stderr || result.stdout || "unknown error",
      ).trim()}`,
    );
  }
  return result;
}

export async function repairAndVerifyGlobalNodePty({
  packageManager,
  packageName,
  runCommand = defaultRunCommand,
  nodeExecutable = process.execPath,
  dependencies = ["node-pty"],
  packageSpec = null,
} = {}) {
  if (!packageManager || !packageName) {
    throw new Error("packageManager and packageName are required");
  }

  if (packageManager === "pnpm") {
    await ensurePnpmOnlyBuiltDependencies({ runCommand, dependencies, global: true });
  }

  const packageDirectory = await resolveGlobalPackageDirectory({
    packageManager,
    packageName,
    runCommand,
  });

  if (packageManager === "pnpm") {
    const ignoredBuilds = await detectPnpmIgnoredBuilds({
      runCommand,
      cwd: packageDirectory,
    });
    const blockedDependencies = normalizeBuiltDependencyList(dependencies).filter((dependency) =>
      ignoredBuilds.includes(dependency),
    );
    if (blockedDependencies.length > 0) {
      throw new Error(
        `pnpm ignored native build scripts for ${blockedDependencies.join(
          ", ",
        )}. Reinstall Conductor with pnpm's build allowlist enabled, for example: pnpm add -g ${buildPnpmAllowBuildArgs(
          blockedDependencies,
        ).join(" ")} ${packageName}@latest`,
      );
    }
    const rebuildResult = await runCommand("pnpm", ["rebuild", ...dependencies], {
      cwd: packageDirectory,
    });
    if (!rebuildResult.success) {
      throw new Error(
        `pnpm rebuild failed: ${String(rebuildResult.stderr || rebuildResult.stdout || "unknown error").trim()}`,
      );
    }
  } else if (packageManager === "npm") {
    const rebuildArgs = ["rebuild", "-g"];
    if (packageSpec) {
      rebuildArgs.push(packageSpec);
    } else {
      rebuildArgs.push(packageName);
    }
    const rebuildResult = await runCommand("npm", rebuildArgs);
    if (!rebuildResult.success) {
      throw new Error(
        `npm rebuild failed: ${String(rebuildResult.stderr || rebuildResult.stdout || "unknown error").trim()}`,
      );
    }
  }
  await verifyNodePtyForPackageDirectory({
    packageDirectory,
    runCommand,
    nodeExecutable,
  });
  return packageDirectory;
}

export function buildNodePtyShellVerificationCommand(scriptPath, packageDirectory) {
  const quotedScriptPath = quoteForSingleQuotedShell(scriptPath);
  const quotedPackageDirectory = quoteForSingleQuotedShell(packageDirectory);
  return `node '${quotedScriptPath}' '${quotedPackageDirectory}'`;
}
