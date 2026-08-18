import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { InstallStatus, Tool } from "./types.js";

const DEFAULT_TIMEOUT_MS = 3000;
const require = createRequire(import.meta.url);

function execCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGKILL");
        resolve({ code: null, stdout, stderr, error: new Error("timeout") });
      }
    }, timeoutMs);

    proc.stdout?.on("data", (b) => (stdout += b.toString()));
    proc.stderr?.on("data", (b) => (stderr += b.toString()));
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: err });
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function which(bin: string, timeoutMs: number): Promise<string | undefined> {
  const res = await execCapture("which", [bin], timeoutMs);
  if (res.code !== 0) return undefined;
  const p = res.stdout.trim().split("\n")[0];
  return p || undefined;
}

export async function checkInstall(
  tool: Tool,
  opts: { timeoutMs?: number } = {},
): Promise<InstallStatus> {
  if (tool === "copilot") {
    return checkCopilotSdkInstall();
  }

  if (tool === "dsh") {
    return checkDshSdkInstall();
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bin = tool; // codex / claude
  const path = await which(bin, timeoutMs);
  if (!path) {
    return { installed: false, error: `${bin} not found in PATH` };
  }

  const res = await execCapture(bin, ["--version"], timeoutMs);
  if (res.error || res.code !== 0) {
    return {
      installed: true,
      path,
      error: res.error?.message ?? (res.stderr.trim() || `exit ${res.code}`),
    };
  }
  const rawLine = (res.stdout.trim() || res.stderr.trim()).split("\n")[0] ?? "";
  return { installed: true, path, version: extractSemver(rawLine) ?? rawLine };
}

/** Pull the first semver-looking token out of an arbitrary `--version` line. */
function extractSemver(line: string): string | undefined {
  const m = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(line);
  return m ? m[0] : undefined;
}

export async function checkInstallAll(opts?: {
  timeoutMs?: number;
}): Promise<Record<Tool, InstallStatus>> {
  const [codex, claude, kimi, copilot, dsh] = await Promise.all([
    checkInstall("codex", opts),
    checkInstall("claude", opts),
    checkInstall("kimi", opts),
    checkInstall("copilot", opts),
    checkInstall("dsh", opts),
  ]);
  return { codex, claude, kimi, copilot, dsh };
}

async function checkCopilotSdkInstall(): Promise<InstallStatus> {
  try {
    const entryPath = require.resolve("@github/copilot-sdk");
    const version = await findPackageVersionForEntry(entryPath, "@github/copilot-sdk");
    return {
      installed: true,
      path: "@github/copilot-sdk",
      version: version ?? "installed",
    };
  } catch (err: any) {
    return {
      installed: false,
      error: `@github/copilot-sdk not available: ${err?.message ?? err}`,
    };
  }
}

/**
 * DeepSeek Harness ships as pinned dependencies of this package rather than a
 * CLI on PATH, so the reported version is the runtime package's own npm
 * version — the same shape as the Copilot SDK probe above.
 */
async function checkDshSdkInstall(): Promise<InstallStatus> {
  const RUNTIME_PACKAGE = "@deepseek-ai/dsh-sdk-jsonrpc-demo";
  try {
    const entryPath = require.resolve(`${RUNTIME_PACKAGE}/bin`);
    const version = await findPackageVersionForEntry(entryPath, RUNTIME_PACKAGE);
    return {
      installed: true,
      path: RUNTIME_PACKAGE,
      version: version ?? "installed",
    };
  } catch (err: any) {
    return {
      installed: false,
      error: `${RUNTIME_PACKAGE} not available: ${err?.message ?? err}`,
    };
  }
}

/** Exported for tests. */
export async function findPackageVersionForEntry(
  entryPath: string,
  packageName: string,
): Promise<string | undefined> {
  let dir = dirname(entryPath);
  while (true) {
    const pkgPath = join(dir, "package.json");
    try {
      const payload = JSON.parse(await readFile(pkgPath, "utf8")) as Record<string, unknown>;
      if (payload.name === packageName) {
        const version = typeof payload.version === "string" ? payload.version.trim() : "";
        return version || undefined;
      }
    } catch {
      // Walk upward until we hit the package root or filesystem root.
    }

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
