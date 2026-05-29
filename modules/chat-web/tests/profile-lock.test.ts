import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProfileLockedError } from "../src/core/errors.js";
import {
  clearProfileOwner,
  reclaimProfileLock,
  writeProfileOwner,
} from "../src/core/profile-lock.js";

const OWNER_FILE = ".chat-web-owner.json";
const silentLogger = { error() {}, warn() {}, info() {}, debug() {} };

function writeSingletonLock(userDataDir: string, pid: number): void {
  fs.symlinkSync(`testhost-${pid}`, path.join(userDataDir, "SingletonLock"));
}

function deadPid(): number {
  // A pid that is essentially certain not to be running.
  return 2_147_483_000;
}

describe("reclaimProfileLock", () => {
  let userDataDir: string;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-web-lock-"));
  });

  afterEach(async () => {
    for (const child of children.splice(0)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    await fsp.rm(userDataDir, { recursive: true, force: true });
  });

  it("is a no-op when there is no SingletonLock", async () => {
    await expect(
      reclaimProfileLock({ userDataDir, provider: "chatgpt", logger: silentLogger }),
    ).resolves.toBeUndefined();
  });

  it("clears a stale lock whose pid is no longer running", async () => {
    writeSingletonLock(userDataDir, deadPid());
    fs.writeFileSync(path.join(userDataDir, "SingletonCookie"), "x");

    await reclaimProfileLock({ userDataDir, provider: "chatgpt", logger: silentLogger });

    expect(fs.existsSync(path.join(userDataDir, "SingletonLock"))).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, "SingletonCookie"))).toBe(false);
  });

  it("reclaims an orphaned browser (lock alive, owner process gone)", async () => {
    // A live process whose command line claims this profile, standing in for
    // an orphaned Chromium that survived its owner.
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)", "--", `--user-data-dir=${userDataDir}`],
      { stdio: "ignore" },
    );
    children.push(child);
    await new Promise((resolve) => setTimeout(resolve, 150));

    writeSingletonLock(userDataDir, child.pid!);
    // Owner sidecar points at a dead pid → the browser is an orphan.
    fs.writeFileSync(
      path.join(userDataDir, OWNER_FILE),
      JSON.stringify({ ownerPid: deadPid(), provider: "chatgpt", startedAt: "x" }),
    );

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await reclaimProfileLock({ userDataDir, provider: "chatgpt", logger: silentLogger });

    await exited; // orphan was terminated (external process.kill, so child.killed stays false)
    expect(fs.existsSync(path.join(userDataDir, "SingletonLock"))).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, OWNER_FILE))).toBe(false);
  });

  it("throws ProfileLockedError when a genuine live chat owns the profile", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)", "--", `--user-data-dir=${userDataDir}`],
      { stdio: "ignore" },
    );
    children.push(child);
    await new Promise((resolve) => setTimeout(resolve, 150));

    writeSingletonLock(userDataDir, child.pid!);
    // Owner is THIS test process → alive → a real live chat.
    writeProfileOwner(userDataDir, "chatgpt");

    await expect(
      reclaimProfileLock({ userDataDir, provider: "chatgpt", logger: silentLogger }),
    ).rejects.toBeInstanceOf(ProfileLockedError);
    // The live browser must NOT have been touched.
    expect(child.killed).toBe(false);
  });

  it("writeProfileOwner / clearProfileOwner round-trip", () => {
    writeProfileOwner(userDataDir, "chatgpt");
    expect(fs.existsSync(path.join(userDataDir, OWNER_FILE))).toBe(true);
    clearProfileOwner(userDataDir);
    expect(fs.existsSync(path.join(userDataDir, OWNER_FILE))).toBe(false);
  });
});
