import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";

import { defaultLogger, type Logger } from "./logger.js";

/**
 * Substrings (lower-cased) that identify Playwright's "browser binary is
 * missing" error. Playwright's exact wording has shifted across versions
 * but the core sentinels stay stable.
 */
const BROWSER_MISSING_HINTS = [
  "executable doesn't exist",
  "please run the following command to download new browsers",
  "browsertype.launch", // every variant starts with this when the binary is missing
  "npx playwright install",
] as const;

/**
 * Returns true when an error thrown by Playwright's `launchPersistentContext`
 * / `launch` is the well-known "Chromium binary not installed" condition.
 *
 * We match on multiple hint substrings rather than a single regex because
 * Playwright has historically rephrased this error every couple of
 * minor releases; missing only the "browsertype.launch" prefix would break
 * detection on first contact with a new wording.
 */
export function isBrowserMissingError(err: unknown): boolean {
  const msg = String((err as Error | undefined)?.message ?? "").toLowerCase();
  if (!msg) return false;
  return BROWSER_MISSING_HINTS.some((hint) => msg.includes(hint));
}

/**
 * Honour `CHAT_WEB_NO_AUTO_INSTALL` / `CHAT_WEB_SKIP_BROWSER_INSTALL` to
 * disable the auto-install path entirely. Useful in CI / Docker where the
 * operator wants explicit control over browser provisioning.
 */
export function autoInstallDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  for (const key of ["CHAT_WEB_NO_AUTO_INSTALL", "CHAT_WEB_SKIP_BROWSER_INSTALL"]) {
    const v = env[key];
    if (v === "1" || v === "true" || v === "yes") return true;
  }
  return false;
}

export interface InstallChromiumOptions {
  logger?: Logger;
  /** Override the command (mostly for tests). Default: "npx". */
  command?: string;
  /** Override the args (mostly for tests). Default: ["--yes", "playwright", "install", "chromium"]. */
  args?: string[];
  /** Custom spawn function (for tests). Defaults to node:child_process.spawn. */
  spawnFn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Override environment passed to the child. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Cancel the install. */
  signal?: AbortSignal;
  /** Hard cap on the install duration. Default: 5 minutes. */
  timeoutMs?: number;
}

export interface InstallChromiumResult {
  command: string;
  args: readonly string[];
  exitCode: number;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

/**
 * Runs `npx --yes playwright install chromium` to its conclusion.
 *
 * Resolves with the exit info on success (exitCode === 0), rejects with
 * an `Error` whose message includes the stderr tail otherwise. We don't
 * stream the binary download to stdout — that's noisy — but we keep the
 * last ~2KB of each stream so callers can attach useful diagnostics if
 * the install fails.
 */
export function installChromium(
  options: InstallChromiumOptions = {},
): Promise<InstallChromiumResult> {
  const command = options.command ?? "npx";
  const args = options.args ?? ["--yes", "playwright", "install", "chromium"];
  const spawnFn = options.spawnFn ?? (spawn as InstallChromiumOptions["spawnFn"])!;
  const env = options.env ?? process.env;
  const logger = options.logger ?? defaultLogger;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const start = Date.now();

  logger.info(
    `chat-web: installing Chromium via \`${command} ${args.join(" ")}\` (first-run only) …`,
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutTail = "";
    let stderrTail = "";

    const child = spawnFn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    const onAbort = () => {
      if (settled) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
    };
    options.signal?.addEventListener("abort", onAbort);

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
      finalize(
        new Error(
          `chat-web: Chromium install timed out after ${timeoutMs}ms. Run manually: \`${command} ${args.join(" ")}\``,
        ),
      );
    }, timeoutMs);
    if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();

    const appendTail = (current: string, chunk: string): string => {
      const combined = current + chunk;
      return combined.length > 2048 ? combined.slice(-2048) : combined;
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      stdoutTail = appendTail(stdoutTail, s);
      // Surface progress lines at debug level — full output is noisy.
      logger.debug(s.replace(/\n+$/, ""));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      stderrTail = appendTail(stderrTail, s);
      logger.debug(s.replace(/\n+$/, ""));
    });

    child.on("error", (err) => finalize(err));
    child.on("exit", (code, signal) => {
      if (code === 0) {
        finalize(null);
      } else {
        const reason = code !== null ? `exit code ${code}` : `signal ${signal}`;
        finalize(
          new Error(
            `chat-web: \`${command} ${args.join(" ")}\` failed (${reason}). Last stderr:\n${stderrTail.trim() || "(empty)"}`,
          ),
        );
      }
    });

    function finalize(err: Error | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (err) {
        reject(err);
        return;
      }
      const durationMs = Date.now() - start;
      logger.info(`chat-web: Chromium install finished in ${Math.round(durationMs / 1000)}s.`);
      resolve({
        command,
        args,
        exitCode: 0,
        durationMs,
        stdoutTail,
        stderrTail,
      });
    }
  });
}

/**
 * Module-private flag so we attempt auto-install at most once per process.
 * Subsequent failures fall through to the original BrowserLaunchError so
 * we don't loop on a genuinely broken environment.
 */
let attempted = false;

export function hasAttemptedAutoInstall(): boolean {
  return attempted;
}

export function markAutoInstallAttempted(): void {
  attempted = true;
}

/** Test-only: reset the once-per-process guard. */
export function _resetAutoInstallGuardForTests(): void {
  attempted = false;
}
