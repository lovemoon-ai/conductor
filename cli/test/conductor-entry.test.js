import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runConductorCli } from "../bin/conductor.js";

describe("conductor entry", () => {
  it("dispatches subcommands and triggers non-blocking update checks", async () => {
    const originalArgv = process.argv;
    const env = {};
    const notices = [];
    const importedPaths = [];
    let checkCalled = false;

    try {
      const result = runConductorCli(["fire", "--help"], {
        env,
        processArgv: ["node", "/mock/bin/conductor.js", "fire", "--help"],
        existsSync: () => true,
        maybeCheckForUpdates: () => {
          checkCalled = true;
          return new Promise(() => {});
        },
        importModule: async (subcommandPath) => {
          importedPaths.push(subcommandPath);
        },
        console: {
          log: (message) => notices.push(message),
          error: (message) => notices.push(message),
        },
      });

      assert.deepStrictEqual(result, { shouldExit: false, exitCode: 0 });
      assert.strictEqual(checkCalled, true);
      assert.strictEqual(importedPaths.length, 1);
      assert.match(importedPaths[0], /bin\/conductor-fire\.js$/);
      assert.strictEqual(env.CONDUCTOR_CLI_NAME, "conductor fire");
      assert.strictEqual(env.CONDUCTOR_LAUNCHER_SCRIPT, "/mock/bin/conductor.js");
      assert.strictEqual(env.CONDUCTOR_SUBCOMMAND, "fire");
      assert.strictEqual(env.CONDUCTOR_SUBCOMMAND_ARGS_JSON, JSON.stringify(["--help"]));
      assert.deepStrictEqual(process.argv, ["node", importedPaths[0], "--help"]);
      assert.deepStrictEqual(notices, []);
    } finally {
      process.argv = originalArgv;
    }
  });

  it("routes serve-ai like other first-class subcommands", async () => {
    const originalArgv = process.argv;
    const env = {};
    const importedPaths = [];

    try {
      const result = runConductorCli(["serve-ai", "--help"], {
        env,
        processArgv: ["node", "/mock/bin/conductor.js", "serve-ai", "--help"],
        existsSync: () => true,
        maybeCheckForUpdates: () => Promise.resolve(),
        importModule: async (subcommandPath) => {
          importedPaths.push(subcommandPath);
        },
        console: {
          log: () => {},
          error: () => {},
        },
      });

      assert.deepStrictEqual(result, { shouldExit: false, exitCode: 0 });
      assert.strictEqual(importedPaths.length, 1);
      assert.match(importedPaths[0], /bin\/conductor-serve-ai\.js$/);
      assert.strictEqual(env.CONDUCTOR_CLI_NAME, "conductor serve-ai");
      assert.strictEqual(env.CONDUCTOR_SUBCOMMAND, "serve-ai");
      assert.strictEqual(env.CONDUCTOR_SUBCOMMAND_ARGS_JSON, JSON.stringify(["--help"]));
      assert.deepStrictEqual(process.argv, ["node", importedPaths[0], "--help"]);
    } finally {
      process.argv = originalArgv;
    }
  });

  it("returns help/version/unknown-command exits without update checks", () => {
    let checkCalls = 0;
    let importCalls = 0;
    const errors = [];
    const logs = [];
    const consoleImpl = {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    };

    const helpResult = runConductorCli(["--help"], {
      maybeCheckForUpdates: () => {
        checkCalls += 1;
        return Promise.resolve();
      },
      importModule: async () => {
        importCalls += 1;
      },
      console: consoleImpl,
    });
    assert.deepStrictEqual(helpResult, { shouldExit: true, exitCode: 0 });

    const versionResult = runConductorCli(["--version"], {
      maybeCheckForUpdates: () => {
        checkCalls += 1;
        return Promise.resolve();
      },
      importModule: async () => {
        importCalls += 1;
      },
      console: consoleImpl,
    });
    assert.deepStrictEqual(versionResult, { shouldExit: true, exitCode: 0 });
    assert.match(logs.at(-1), /conductor version/);

    const unknownResult = runConductorCli(["unknown-cmd"], {
      maybeCheckForUpdates: () => {
        checkCalls += 1;
        return Promise.resolve();
      },
      importModule: async () => {
        importCalls += 1;
      },
      console: consoleImpl,
    });
    assert.deepStrictEqual(unknownResult, { shouldExit: true, exitCode: 1 });
    assert.match(errors[0], /Unknown subcommand/);

    assert.strictEqual(checkCalls, 0);
    assert.strictEqual(importCalls, 0);
  });

  it("fails fast when the routed subcommand file is missing", () => {
    const errors = [];
    const result = runConductorCli(["diagnose"], {
      existsSync: () => false,
      maybeCheckForUpdates: () => Promise.resolve(),
      console: {
        log: () => {},
        error: (message) => errors.push(message),
      },
    });

    assert.deepStrictEqual(result, { shouldExit: true, exitCode: 1 });
    assert.match(errors[0], /Subcommand implementation not found/);
  });
});
