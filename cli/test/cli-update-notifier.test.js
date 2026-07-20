import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildUpdateNotice,
  maybeCheckForUpdates,
  readVersionCheckCache,
  resolveVersionCheckCachePath,
  shouldSkipVersionCheck,
} from "../src/cli-update-notifier.js";

function createTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "conductor-update-notifier-"));
}

async function writeCache(homeDir, value) {
  const cachePath = resolveVersionCheckCachePath({ homeDir });
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(value, null, 2), "utf8");
  return cachePath;
}

describe("shouldSkipVersionCheck", () => {
  it("skips in non-tty, CI, update, nested, or explicit skip scenarios", () => {
    assert.deepStrictEqual(
      shouldSkipVersionCheck({
        subcommand: "fire",
        env: {},
        stdoutIsTTY: false,
      }),
      { skip: true, reason: "non_tty" },
    );
    assert.deepStrictEqual(
      shouldSkipVersionCheck({
        subcommand: "fire",
        env: { CI: "true" },
        stdoutIsTTY: true,
      }),
      { skip: true, reason: "ci" },
    );
    assert.deepStrictEqual(
      shouldSkipVersionCheck({
        subcommand: "update",
        env: {},
        stdoutIsTTY: true,
      }),
      { skip: true, reason: "update_subcommand" },
    );
    assert.deepStrictEqual(
      shouldSkipVersionCheck({
        subcommand: "fire",
        env: { CONDUCTOR_CLI_COMMAND: "codex" },
        stdoutIsTTY: true,
      }),
      { skip: true, reason: "nested_cli" },
    );
    assert.deepStrictEqual(
      shouldSkipVersionCheck({
        subcommand: "fire",
        env: { CONDUCTOR_SKIP_UPDATE_CHECK: "1" },
        stdoutIsTTY: true,
      }),
      { skip: true, reason: "disabled_by_env" },
    );
  });

  it("does not skip normal interactive top-level commands", () => {
    assert.deepStrictEqual(
      shouldSkipVersionCheck({
        subcommand: "fire",
        env: {},
        stdoutIsTTY: true,
      }),
      { skip: false, reason: null },
    );
  });
});

describe("resolveVersionCheckCachePath", () => {
  it("stores the version cache under CONDUCTOR_HOME", () => {
    assert.strictEqual(
      resolveVersionCheckCachePath({
        env: {
          HOME: "/tmp/ignored-home",
          CONDUCTOR_HOME: "/tmp/custom-conductor-home",
        },
      }),
      path.resolve("/tmp/custom-conductor-home/version-check.json"),
    );
  });
});

describe("buildUpdateNotice", () => {
  it("formats a single-line upgrade hint", () => {
    assert.strictEqual(
      buildUpdateNotice({ currentVersion: "0.2.20", latestVersion: "0.2.21" }),
      "New conductor version available: 0.2.20 -> 0.2.21. Run: conductor update",
    );
  });

  it("switches the hint for Homebrew-managed installs", () => {
    assert.strictEqual(
      buildUpdateNotice({
        currentVersion: "0.2.20",
        latestVersion: "0.2.21",
        installMethod: "homebrew",
      }),
      "New conductor version available: 0.2.20 -> 0.2.21. Run: brew upgrade lovemoon-ai/tap/conductor",
    );
  });
});

describe("maybeCheckForUpdates", () => {
  it("uses cached newer version to notify without re-fetching", async () => {
    const homeDir = createTempHome();
    const nowMs = Date.parse("2026-03-18T12:00:00.000Z");
    let fetchCalls = 0;
    const notices = [];
    await writeCache(homeDir, {
      lastCheckedAt: new Date(nowMs).toISOString(),
      latestVersion: "0.2.21",
      latestCheckedAt: new Date(nowMs).toISOString(),
    });

    await maybeCheckForUpdates({
      currentVersion: "0.2.20",
      subcommand: "fire",
      env: { HOME: homeDir },
      stdoutIsTTY: true,
      nowMs,
      fetchLatestVersion: async () => {
        fetchCalls += 1;
        return "0.2.22";
      },
      writeNotice: (message) => notices.push(message),
    });

    const cache = await readVersionCheckCache({ homeDir });
    assert.strictEqual(fetchCalls, 0);
    assert.deepStrictEqual(notices, [
      "New conductor version available: 0.2.20 -> 0.2.21. Run: conductor update",
    ]);
    assert.strictEqual(cache.lastNotifiedVersion, "0.2.21");
    assert.strictEqual(cache.lastNotifiedAt, new Date(nowMs).toISOString());
  });

  it("suppresses repeated notices for the same version within the notify interval", async () => {
    const homeDir = createTempHome();
    const nowMs = Date.parse("2026-03-18T12:00:00.000Z");
    const notices = [];
    await writeCache(homeDir, {
      lastCheckedAt: new Date(nowMs).toISOString(),
      latestVersion: "0.2.21",
      latestCheckedAt: new Date(nowMs).toISOString(),
      lastNotifiedVersion: "0.2.21",
      lastNotifiedAt: new Date(nowMs - 60 * 60 * 1000).toISOString(),
    });

    await maybeCheckForUpdates({
      currentVersion: "0.2.20",
      subcommand: "fire",
      env: { HOME: homeDir },
      stdoutIsTTY: true,
      nowMs,
      writeNotice: (message) => notices.push(message),
    });

    assert.deepStrictEqual(notices, []);
  });

  it("refreshes stale cache, persists the new latest version, and notifies once", async () => {
    const homeDir = createTempHome();
    const nowMs = Date.parse("2026-03-18T12:00:00.000Z");
    let fetchCalls = 0;
    const notices = [];
    await writeCache(homeDir, {
      lastCheckedAt: new Date(nowMs - 13 * 60 * 60 * 1000).toISOString(),
    });

    await maybeCheckForUpdates({
      currentVersion: "0.2.20",
      subcommand: "fire",
      env: { HOME: homeDir },
      stdoutIsTTY: true,
      nowMs,
      fetchLatestVersion: async () => {
        fetchCalls += 1;
        return "0.2.22";
      },
      writeNotice: (message) => notices.push(message),
    });

    const cache = await readVersionCheckCache({ homeDir });
    assert.strictEqual(fetchCalls, 1);
    assert.deepStrictEqual(notices, [
      "New conductor version available: 0.2.20 -> 0.2.22. Run: conductor update",
    ]);
    assert.strictEqual(cache.lastCheckedAt, new Date(nowMs).toISOString());
    assert.strictEqual(cache.latestVersion, "0.2.22");
    assert.strictEqual(cache.lastNotifiedVersion, "0.2.22");
  });

  it("records failed checks so repeated commands do not re-fetch immediately", async () => {
    const homeDir = createTempHome();
    const notices = [];
    let fetchCalls = 0;
    const firstNowMs = Date.parse("2026-03-18T12:00:00.000Z");

    await maybeCheckForUpdates({
      currentVersion: "0.2.20",
      subcommand: "fire",
      env: { HOME: homeDir },
      stdoutIsTTY: true,
      nowMs: firstNowMs,
      fetchLatestVersion: async () => {
        fetchCalls += 1;
        throw new Error("network down");
      },
      writeNotice: (message) => notices.push(message),
    });

    await maybeCheckForUpdates({
      currentVersion: "0.2.20",
      subcommand: "fire",
      env: { HOME: homeDir },
      stdoutIsTTY: true,
      nowMs: firstNowMs + 60 * 60 * 1000,
      fetchLatestVersion: async () => {
        fetchCalls += 1;
        return "0.2.22";
      },
      writeNotice: (message) => notices.push(message),
    });

    const cache = await readVersionCheckCache({ homeDir });
    assert.strictEqual(fetchCalls, 1);
    assert.deepStrictEqual(notices, []);
    assert.strictEqual(cache.lastCheckedAt, new Date(firstNowMs).toISOString());
  });

  it("falls back to a stale cached latest version for notification when refresh fails", async () => {
    const homeDir = createTempHome();
    const nowMs = Date.parse("2026-03-18T12:00:00.000Z");
    const notices = [];
    await writeCache(homeDir, {
      lastCheckedAt: new Date(nowMs - 13 * 60 * 60 * 1000).toISOString(),
      latestVersion: "0.2.21",
      latestCheckedAt: new Date(nowMs - 13 * 60 * 60 * 1000).toISOString(),
    });

    await maybeCheckForUpdates({
      currentVersion: "0.2.20",
      subcommand: "fire",
      env: { HOME: homeDir },
      stdoutIsTTY: true,
      nowMs,
      fetchLatestVersion: async () => {
        throw new Error("timeout");
      },
      writeNotice: (message) => notices.push(message),
    });

    const cache = await readVersionCheckCache({ homeDir });
    assert.deepStrictEqual(notices, [
      "New conductor version available: 0.2.20 -> 0.2.21. Run: conductor update",
    ]);
    assert.strictEqual(cache.lastCheckedAt, new Date(nowMs).toISOString());
    assert.strictEqual(cache.lastNotifiedVersion, "0.2.21");
  });

  it("honors skip env without reading or writing cache", async () => {
    const homeDir = createTempHome();
    let fetchCalls = 0;

    const result = await maybeCheckForUpdates({
      currentVersion: "0.2.20",
      subcommand: "fire",
      env: {
        HOME: homeDir,
        CONDUCTOR_SKIP_UPDATE_CHECK: "1",
      },
      stdoutIsTTY: true,
      fetchLatestVersion: async () => {
        fetchCalls += 1;
        return "0.2.22";
      },
    });

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(fetchCalls, 0);
    assert.strictEqual(fs.existsSync(resolveVersionCheckCachePath({ homeDir })), false);
  });
});
