import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetAutoInstallGuardForTests,
  autoInstallDisabled,
  hasAttemptedAutoInstall,
  installChromium,
  isBrowserMissingError,
  markAutoInstallAttempted,
} from "../src/core/install-chromium.js";

describe("isBrowserMissingError", () => {
  it("matches Playwright's classic 'Executable doesn't exist' wording", () => {
    const err = new Error(
      "browserType.launchPersistentContext: Executable doesn't exist at /Users/me/Library/Caches/ms-playwright/chromium-1217/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    );
    expect(isBrowserMissingError(err)).toBe(true);
  });

  it("matches the 'Please run the following command' install prompt", () => {
    const err = new Error(
      "browserType.launch: ╔═════════════════╗\n║ Please run the following command to download new browsers: ║\n║     npx playwright install ║\n╚═════════════════╝",
    );
    expect(isBrowserMissingError(err)).toBe(true);
  });

  it("matches case-insensitively", () => {
    const err = new Error("browserType.launch: EXECUTABLE DOESN'T EXIST at ...");
    expect(isBrowserMissingError(err)).toBe(true);
  });

  it("does not match unrelated launch failures", () => {
    expect(
      isBrowserMissingError(new Error("ECONNREFUSED 127.0.0.1:9222")),
    ).toBe(false);
    expect(
      isBrowserMissingError(new Error("Target closed")),
    ).toBe(false);
    expect(isBrowserMissingError(undefined)).toBe(false);
    expect(isBrowserMissingError(null)).toBe(false);
    expect(isBrowserMissingError("plain string")).toBe(false);
  });
});

describe("autoInstallDisabled", () => {
  it("returns false on a clean env", () => {
    expect(autoInstallDisabled({})).toBe(false);
  });

  it("honours CHAT_WEB_NO_AUTO_INSTALL=1 / true / yes", () => {
    expect(autoInstallDisabled({ CHAT_WEB_NO_AUTO_INSTALL: "1" })).toBe(true);
    expect(autoInstallDisabled({ CHAT_WEB_NO_AUTO_INSTALL: "true" })).toBe(true);
    expect(autoInstallDisabled({ CHAT_WEB_NO_AUTO_INSTALL: "yes" })).toBe(true);
  });

  it("honours CHAT_WEB_SKIP_BROWSER_INSTALL as a synonym", () => {
    expect(autoInstallDisabled({ CHAT_WEB_SKIP_BROWSER_INSTALL: "1" })).toBe(true);
  });

  it("ignores arbitrary truthy strings (e.g. '0', 'false', 'no')", () => {
    expect(autoInstallDisabled({ CHAT_WEB_NO_AUTO_INSTALL: "0" })).toBe(false);
    expect(autoInstallDisabled({ CHAT_WEB_NO_AUTO_INSTALL: "false" })).toBe(false);
    expect(autoInstallDisabled({ CHAT_WEB_NO_AUTO_INSTALL: "no" })).toBe(false);
    expect(autoInstallDisabled({ CHAT_WEB_NO_AUTO_INSTALL: "" })).toBe(false);
  });
});

describe("once-per-process guard", () => {
  beforeEach(() => _resetAutoInstallGuardForTests());
  afterEach(() => _resetAutoInstallGuardForTests());

  it("starts un-attempted, latches after markAutoInstallAttempted()", () => {
    expect(hasAttemptedAutoInstall()).toBe(false);
    markAutoInstallAttempted();
    expect(hasAttemptedAutoInstall()).toBe(true);
  });

  it("test reset helper clears the latch", () => {
    markAutoInstallAttempted();
    _resetAutoInstallGuardForTests();
    expect(hasAttemptedAutoInstall()).toBe(false);
  });
});

/**
 * Fake child_process.spawn so we can drive installChromium deterministically
 * without actually downloading Chromium.
 */
function createFakeChild(): {
  child: EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (signal?: string) => void;
    killed: boolean;
  };
  emitData(stream: "stdout" | "stderr", chunk: string): void;
  exit(code: number | null, signal?: string | null): void;
  error(err: Error): void;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (signal?: string) => void;
    killed: boolean;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return {
    child,
    emitData(stream, chunk) {
      const target = stream === "stdout" ? stdout : stderr;
      target.emit("data", Buffer.from(chunk, "utf8"));
    },
    exit(code, signal = null) {
      child.emit("exit", code, signal);
    },
    error(err) {
      child.emit("error", err);
    },
  };
}

const silentLogger = {
  level: "silent" as const,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};

describe("installChromium", () => {
  it("resolves with exit info when the spawn exits with code 0", async () => {
    const fake = createFakeChild();
    let spawnedWith: { command: string; args: readonly string[] } | null = null;

    const promise = installChromium({
      logger: silentLogger,
      spawnFn: (command, args) => {
        spawnedWith = { command, args };
        return fake.child as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });

    // Simulate some output then a clean exit.
    fake.emitData("stdout", "Downloading Chromium 123…\n");
    fake.exit(0);

    const result = await promise;
    expect(spawnedWith?.command).toBe("npx");
    expect(spawnedWith?.args).toEqual(["--yes", "playwright", "install", "chromium"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTail).toContain("Downloading Chromium");
  });

  it("rejects with a useful error when the spawn exits with non-zero code", async () => {
    const fake = createFakeChild();
    const promise = installChromium({
      logger: silentLogger,
      spawnFn: () => fake.child as unknown as ReturnType<typeof import("node:child_process").spawn>,
    });

    fake.emitData("stderr", "Error: failed to fetch chromium archive\n");
    fake.exit(1);

    await expect(promise).rejects.toThrow(/failed \(exit code 1\)/);
    await expect(promise).rejects.toThrow(/failed to fetch chromium archive/);
  });

  it("rejects when the child emits an error event", async () => {
    const fake = createFakeChild();
    const promise = installChromium({
      logger: silentLogger,
      spawnFn: () => fake.child as unknown as ReturnType<typeof import("node:child_process").spawn>,
    });

    fake.error(new Error("ENOENT: npx not on PATH"));
    await expect(promise).rejects.toThrow(/ENOENT/);
  });

  it("kills the child and rejects when AbortSignal fires", async () => {
    const fake = createFakeChild();
    const controller = new AbortController();
    const promise = installChromium({
      logger: silentLogger,
      signal: controller.signal,
      spawnFn: () => fake.child as unknown as ReturnType<typeof import("node:child_process").spawn>,
    });

    controller.abort();
    expect(fake.child.killed).toBe(true);

    // The abort itself doesn't reject — the child will surface either an
    // exit (with a non-zero code/signal) or an error. Simulate the exit.
    fake.exit(null, "SIGTERM");
    await expect(promise).rejects.toThrow(/signal SIGTERM/);
  });
});
