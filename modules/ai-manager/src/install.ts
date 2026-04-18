import { spawn } from "node:child_process";
import type { InstallStatus, Tool } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 3000;

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
  const version = (res.stdout.trim() || res.stderr.trim()).split("\n")[0];
  return { installed: true, path, version };
}

export async function checkInstallAll(opts?: {
  timeoutMs?: number;
}): Promise<Record<Tool, InstallStatus>> {
  const [codex, claude] = await Promise.all([
    checkInstall("codex", opts),
    checkInstall("claude", opts),
  ]);
  return { codex, claude };
}
