import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ProfileLockedError } from "./errors.js";
import { defaultLogger, type Logger } from "./logger.js";

/**
 * "One live chat per profile" enforcement + stale/orphan lock reclaim.
 *
 * chat-web persists a full Chromium `userDataDir` per provider (RFC §19.1),
 * and Chromium guards that directory with a `SingletonLock` symlink. Because
 * every fire task is its own process, two tasks for the same provider would
 * otherwise race for the same profile and the second one fails with
 * `launchPersistentContext: Opening in existing browser session`.
 *
 * We make that contract explicit and self-healing:
 *   - no lock / lock pid dead            → clear stale lock, proceed
 *   - lock pid alive, not our Chromium   → pid reuse, clear stale lock, proceed
 *   - lock pid alive, our Chromium, but
 *     its owning worker is gone          → orphan, kill + reclaim, proceed
 *   - lock pid alive, owner alive         → genuine live chat → throw
 *
 * The "owner" is the worker/process that launched the browser; we record its
 * pid in a small sidecar file so a later launch can tell an orphaned browser
 * (owner died, e.g. worker SIGKILLed) apart from one a live task still uses.
 */

const OWNER_FILE = ".chat-web-owner.json";
const SINGLETON_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"] as const;

interface ProfileOwner {
  ownerPid: number;
  provider: string;
  startedAt: string;
}

function ownerFilePath(userDataDir: string): string {
  return path.join(userDataDir, OWNER_FILE);
}

function isProcessAlive(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs error checking without actually sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it → still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

function readSingletonLockPid(userDataDir: string): number | null {
  try {
    // Chromium writes SingletonLock as a symlink: "<hostname>-<pid>".
    const target = fs.readlinkSync(path.join(userDataDir, "SingletonLock"));
    const match = /-(\d+)\s*$/.exec(target);
    if (!match) return null;
    const pid = Number.parseInt(match[1]!, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    // Not a symlink / does not exist → nothing decipherable to reclaim.
    return null;
  }
}

function processCommandLine(pid: number): string {
  if (process.platform === "win32") return "";
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
    }).trim();
  } catch {
    return "";
  }
}

function clearSingletonFiles(userDataDir: string): void {
  for (const name of SINGLETON_FILES) {
    try {
      fs.rmSync(path.join(userDataDir, name), { force: true });
    } catch {
      // best effort
    }
  }
}

function readOwner(userDataDir: string): ProfileOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerFilePath(userDataDir), "utf8")) as ProfileOwner;
    return parsed && Number.isInteger(parsed.ownerPid) ? parsed : null;
  } catch {
    return null;
  }
}

/** Record the current process as the owner of this profile's browser. */
export function writeProfileOwner(userDataDir: string, provider: string): void {
  try {
    const owner: ProfileOwner = {
      ownerPid: process.pid,
      provider,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(ownerFilePath(userDataDir), JSON.stringify(owner), "utf8");
  } catch {
    // Non-fatal: the owner file is only an optimisation for orphan detection.
  }
}

/** Remove the owner sidecar once the browser context is closed. */
export function clearProfileOwner(userDataDir: string): void {
  try {
    fs.rmSync(ownerFilePath(userDataDir), { force: true });
  } catch {
    // best effort
  }
}

/**
 * Reclaim stale/orphaned Chromium locks for a profile, or throw
 * `ProfileLockedError` if a genuine live chat is still using it.
 * Call this immediately before `launchPersistentContext`.
 */
export async function reclaimProfileLock(params: {
  userDataDir: string;
  provider: string;
  logger?: Logger;
}): Promise<void> {
  const { userDataDir, provider } = params;
  const logger = params.logger ?? defaultLogger;

  const lockPid = readSingletonLockPid(userDataDir);
  if (lockPid === null) {
    return; // No decipherable lock → let Playwright proceed normally.
  }

  if (!isProcessAlive(lockPid)) {
    logger.warn(
      `chat-web: clearing stale SingletonLock for "${provider}" (pid ${lockPid} no longer running).`,
    );
    clearSingletonFiles(userDataDir);
    clearProfileOwner(userDataDir);
    return;
  }

  // The pid is alive — make sure it is actually this profile's Chromium and
  // not an unrelated process that reused the pid number.
  if (!processCommandLine(lockPid).includes(`--user-data-dir=${userDataDir}`)) {
    logger.warn(
      `chat-web: SingletonLock pid ${lockPid} is not this profile's Chromium; ` +
        `clearing stale lock for "${provider}".`,
    );
    clearSingletonFiles(userDataDir);
    clearProfileOwner(userDataDir);
    return;
  }

  // It is a live Chromium for this profile. Orphan (owner gone) or in use?
  const owner = readOwner(userDataDir);
  if (!owner || !isProcessAlive(owner.ownerPid)) {
    logger.warn(
      `chat-web: reclaiming orphaned Chromium for "${provider}" ` +
        `(browser pid ${lockPid}, owner ${owner ? `pid ${owner.ownerPid}` : "unknown"} no longer running).`,
    );
    // Terminate gracefully so the orphan flushes profile data (cookies /
    // login state), then WAIT for it to exit before clearing the lock. If we
    // cleared the lock while the orphan was still shutting down, its own
    // cleanup could unlink the fresh SingletonLock the new browser writes —
    // reintroducing exactly the lock contention we're fixing.
    try {
      process.kill(lockPid, "SIGTERM");
    } catch {
      // already gone
    }
    if (!(await waitForProcessExit(lockPid, 4_000))) {
      try {
        process.kill(lockPid, "SIGKILL");
      } catch {
        // already gone
      }
      await waitForProcessExit(lockPid, 2_000);
    }
    clearSingletonFiles(userDataDir);
    clearProfileOwner(userDataDir);
    return;
  }

  // Browser alive AND its owner alive → a real live chat. Refuse to launch.
  throw new ProfileLockedError(provider, lockPid, owner.ownerPid);
}
