import { describe, it } from "node:test";
import assert from "node:assert";

import {
  buildUpgradeCommand,
  detectPackageManager,
  fetchLatestVersion,
  isNewerVersion,
  parseUpdateWindow,
  isInUpdateWindow,
  isManagedInstallPath,
  resolveGlobalInstallPrefix,
  resolveInstallMethod,
} from "../src/version-check.js";

describe("isNewerVersion", () => {
  it("returns true when latest > current", () => {
    assert.strictEqual(isNewerVersion("0.2.20", "0.2.19"), true);
    assert.strictEqual(isNewerVersion("0.3.0", "0.2.19"), true);
    assert.strictEqual(isNewerVersion("1.0.0", "0.99.99"), true);
  });

  it("returns false when latest == current", () => {
    assert.strictEqual(isNewerVersion("0.2.19", "0.2.19"), false);
    assert.strictEqual(isNewerVersion("1.0.0", "1.0.0"), false);
  });

  it("returns false when latest < current", () => {
    assert.strictEqual(isNewerVersion("0.2.18", "0.2.19"), false);
    assert.strictEqual(isNewerVersion("0.1.0", "0.2.0"), false);
  });

  it("handles v-prefix", () => {
    assert.strictEqual(isNewerVersion("v0.3.0", "v0.2.0"), true);
    assert.strictEqual(isNewerVersion("v0.2.0", "0.2.0"), false);
  });

  it("handles different lengths", () => {
    assert.strictEqual(isNewerVersion("1.0.0.1", "1.0.0"), true);
    assert.strictEqual(isNewerVersion("1.0.0", "1.0.0.1"), false);
  });

  it("handles null/undefined gracefully", () => {
    assert.strictEqual(isNewerVersion(null, "0.2.19"), false);
    assert.strictEqual(isNewerVersion("0.2.19", null), true);
  });
});

describe("parseUpdateWindow", () => {
  it("parses valid HH:MM-HH:MM format", () => {
    const w = parseUpdateWindow("02:00-04:00");
    assert.strictEqual(w.startMinutes, 120);
    assert.strictEqual(w.endMinutes, 240);
  });

  it("parses single-digit hours", () => {
    const w = parseUpdateWindow("3:30-5:00");
    assert.strictEqual(w.startMinutes, 210);
    assert.strictEqual(w.endMinutes, 300);
  });

  it("falls back to 02:00-04:00 on invalid input", () => {
    const w = parseUpdateWindow("invalid");
    assert.strictEqual(w.startMinutes, 120);
    assert.strictEqual(w.endMinutes, 240);
  });

  it("falls back when hours/minutes are out of range", () => {
    const w = parseUpdateWindow("25:00-26:99");
    assert.strictEqual(w.startMinutes, 120);
    assert.strictEqual(w.endMinutes, 240);
  });

  it("falls back on null/undefined", () => {
    const w = parseUpdateWindow(null);
    assert.strictEqual(w.startMinutes, 120);
    assert.strictEqual(w.endMinutes, 240);
  });
});

describe("isInUpdateWindow", () => {
  it("returns true when current time is inside window", () => {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    // Create a window that covers "now"
    const window = {
      startMinutes: currentMinutes - 10,
      endMinutes: currentMinutes + 10,
    };
    assert.strictEqual(isInUpdateWindow(window), true);
  });

  it("returns false when current time is outside window", () => {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    // Create a window that does NOT cover "now"
    const start = (currentMinutes + 120) % 1440;
    const end = (start + 60) % 1440;
    // Only test non-wrapping case for determinism
    if (start < end) {
      const window = { startMinutes: start, endMinutes: end };
      assert.strictEqual(isInUpdateWindow(window), false);
    }
  });

  it("handles midnight-wrapping window", () => {
    // 23:00-05:00 wraps midnight
    const window = { startMinutes: 23 * 60, endMinutes: 5 * 60 };
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const expected =
      currentMinutes >= 23 * 60 || currentMinutes < 5 * 60;
    assert.strictEqual(isInUpdateWindow(window), expected);
  });
});

describe("isManagedInstallPath", () => {
  it("returns true for installed node_modules paths", () => {
    assert.strictEqual(
      isManagedInstallPath("/usr/local/lib/node_modules/@love-moon/conductor-cli"),
      true,
    );
  });

  it("returns false for local repository paths", () => {
    assert.strictEqual(
      isManagedInstallPath("/home/duino/ws/conductor-worktrees/daemon-auto-update/cli"),
      false,
    );
  });

  it("returns false for Homebrew installs even when layout is managed", () => {
    assert.strictEqual(
      isManagedInstallPath("/opt/homebrew/Cellar/conductor/0.2.34/libexec/package/node_modules/@love-moon/conductor-cli", {
        env: {
          CONDUCTOR_INSTALL_METHOD: "homebrew",
        },
      }),
      false,
    );
  });
});

describe("resolveGlobalInstallPrefix", () => {
  it("derives the prefix from a system npm install", () => {
    assert.strictEqual(
      resolveGlobalInstallPrefix("/usr/local/lib/node_modules/@love-moon/conductor-cli"),
      "/usr/local",
    );
  });

  it("derives the prefix from a Conductor-managed Node install", () => {
    assert.strictEqual(
      resolveGlobalInstallPrefix(
        "/home/duino/.conductor/node-v23.11.0-linux-x64/lib/node_modules/@love-moon/conductor-cli",
      ),
      "/home/duino/.conductor/node-v23.11.0-linux-x64",
    );
  });

  it("derives the prefix from the legacy ~/.conductor layout", () => {
    assert.strictEqual(
      resolveGlobalInstallPrefix("/home/duino/.conductor/lib/node_modules/@love-moon/conductor-cli"),
      "/home/duino/.conductor",
    );
  });

  it("returns null for a git checkout", () => {
    assert.strictEqual(resolveGlobalInstallPrefix("/home/duino/ws/conductor/cli"), null);
  });

  it("returns null for a project-local node_modules install", () => {
    assert.strictEqual(
      resolveGlobalInstallPrefix("/home/duino/ws/app/node_modules/@love-moon/conductor-cli"),
      null,
    );
  });

  it("returns null for empty or non-string input", () => {
    assert.strictEqual(resolveGlobalInstallPrefix(""), null);
    assert.strictEqual(resolveGlobalInstallPrefix("   "), null);
    assert.strictEqual(resolveGlobalInstallPrefix(undefined), null);
    assert.strictEqual(resolveGlobalInstallPrefix(null), null);
  });
});

describe("resolveInstallMethod", () => {
  it("prefers the explicit environment variable", () => {
    assert.strictEqual(
      resolveInstallMethod({
        env: {
          CONDUCTOR_INSTALL_METHOD: "homebrew",
        },
        packageRoot: "/tmp/ignored",
      }),
      "homebrew",
    );
  });
});

describe("buildUpgradeCommand", () => {
  it("defaults to conductor update for npm-style installs", () => {
    assert.strictEqual(buildUpgradeCommand({ env: {} }), "conductor update");
  });

  it("returns brew upgrade for Homebrew installs", () => {
    assert.strictEqual(
      buildUpgradeCommand({
        env: {
          CONDUCTOR_INSTALL_METHOD: "homebrew",
        },
      }),
      "brew upgrade lovemoon-ai/tap/conductor",
    );
  });
});

describe("detectPackageManager", () => {
  it("prefers launcher/package-root hints from the current install", () => {
    assert.strictEqual(
      detectPackageManager({
        launcherPath: "/home/duino/.local/share/pnpm/conductor",
        packageRoot: "/usr/local/lib/node_modules/@love-moon/conductor-cli",
      }),
      "pnpm",
    );
    assert.strictEqual(
      detectPackageManager({
        launcherPath: "/Users/test/.config/yarn/global/node_modules/.bin/conductor",
      }),
      "yarn",
    );
    assert.strictEqual(
      detectPackageManager({
        packageRoot: "/usr/local/lib/node_modules/@love-moon/conductor-cli",
      }),
      "npm",
    );
  });
});

describe("fetchLatestVersion", () => {
  it("uses npm view first so local registry config is respected", async () => {
    let npmCalls = 0;
    const version = await fetchLatestVersion("@love-moon/conductor-cli", {
      execFileSync: () => {
        npmCalls += 1;
        return '"0.2.21"\n';
      },
      httpsGet: () => {
        throw new Error("https fallback should not be used");
      },
    });

    assert.strictEqual(version, "0.2.21");
    assert.strictEqual(npmCalls, 1);
  });

  it("falls back to registry request when npm view fails", async () => {
    const version = await fetchLatestVersion("@love-moon/conductor-cli", {
      execFileSync: () => {
        throw new Error("npm unavailable");
      },
      httpsGet: (_url, _options, callback) => {
        const listeners = new Map();
        const res = {
          statusCode: 200,
          on(event, handler) {
            listeners.set(event, handler);
            return this;
          },
        };
        callback(res);
        setImmediate(() => {
          listeners.get("data")?.('{"version":"0.2.22"}');
          listeners.get("end")?.();
        });
        return {
          on() {
            return this;
          },
          destroy() {},
        };
      },
    });

    assert.strictEqual(version, "0.2.22");
  });

  it("accepts a shorter timeout for quick notifier checks", async () => {
    let timeoutSeen = null;
    await fetchLatestVersion("@love-moon/conductor-cli", {
      timeoutMs: 456,
      execFileSync: () => {
        throw new Error("npm unavailable");
      },
      httpsGet: (_url, options, callback) => {
        timeoutSeen = options.timeout;
        const listeners = new Map();
        const res = {
          statusCode: 200,
          on(event, handler) {
            listeners.set(event, handler);
            return this;
          },
        };
        callback(res);
        setImmediate(() => {
          listeners.get("data")?.('{"version":"0.2.22"}');
          listeners.get("end")?.();
        });
        return {
          on() {
            return this;
          },
          destroy() {},
        };
      },
    });

    assert.strictEqual(timeoutSeen, 456);
  });
});
