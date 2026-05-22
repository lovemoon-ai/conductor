import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ensurePnpmOnlyBuiltDependencies,
  buildPnpmAllowBuildArgs,
  buildNodePtyVerificationScript,
  detectPnpmIgnoredBuilds,
  ensureNodePtySpawnHelperExecutableForPackageDirectory,
  mergeBuiltDependencies,
  normalizeBuiltDependencyList,
  parsePnpmIgnoredBuildsOutput,
  repairAndVerifyGlobalNodePty,
  shouldIgnoreNodePtyVerificationErrorMessage,
} from "../src/native-deps.js";

describe("native deps helpers", () => {
  it("normalizes built dependency config values from multiple formats", () => {
    assert.deepStrictEqual(normalizeBuiltDependencyList(undefined), []);
    assert.deepStrictEqual(normalizeBuiltDependencyList(""), []);
    assert.deepStrictEqual(normalizeBuiltDependencyList('"node-pty"'), ["node-pty"]);
    assert.deepStrictEqual(normalizeBuiltDependencyList('["foo","node-pty"]'), ["foo", "node-pty"]);
    assert.deepStrictEqual(normalizeBuiltDependencyList("foo,node-pty"), ["foo", "node-pty"]);
    assert.deepStrictEqual(normalizeBuiltDependencyList(["foo", "node-pty", ""]), ["foo", "node-pty"]);
  });

  it("merges required built dependencies without duplicates", () => {
    assert.deepStrictEqual(
      mergeBuiltDependencies(["foo", "node-pty"], ["node-pty", "bar"]),
      ["foo", "node-pty", "bar"],
    );
  });

  it("builds pnpm allow-build flags", () => {
    assert.deepStrictEqual(buildPnpmAllowBuildArgs(["node-pty", "@roamhq/wrtc"]), [
      "--allow-build=node-pty",
      "--allow-build=@roamhq/wrtc",
    ]);
  });

  it("parses pnpm ignored-builds output", () => {
    assert.deepStrictEqual(
      parsePnpmIgnoredBuildsOutput(`Automatically ignored builds during installation:
  node-pty
hint: To allow the execution of build scripts for a package, add its name to "pnpm.onlyBuiltDependencies"`),
      ["node-pty"],
    );
    assert.deepStrictEqual(
      parsePnpmIgnoredBuildsOutput(`Automatically ignored builds during installation:
  None`),
      [],
    );
  });

  it("detects pnpm ignored builds from a project directory", async () => {
    const calls = [];
    const ignored = await detectPnpmIgnoredBuilds({
      cwd: "/tmp/global/node_modules/@love-moon/conductor-cli",
      runCommand: async (command, args, options) => {
        calls.push([command, args, options]);
        return {
          success: true,
          code: 0,
          stdout: "Automatically ignored builds during installation:\n  node-pty\n",
          stderr: "",
        };
      },
    });

    assert.deepStrictEqual(ignored, ["node-pty"]);
    assert.deepStrictEqual(calls, [
      ["pnpm", ["ignored-builds"], { cwd: "/tmp/global/node_modules/@love-moon/conductor-cli" }],
    ]);
  });

  it("writes pnpm onlyBuiltDependencies when node-pty is missing", async () => {
    const calls = [];
    const merged = await ensurePnpmOnlyBuiltDependencies({
      runCommand: async (command, args) => {
        calls.push([command, args]);
        if (args[1] === "get") {
          return { success: true, code: 0, stdout: '["foo"]', stderr: "" };
        }
        return { success: true, code: 0, stdout: "", stderr: "" };
      },
      dependencies: ["node-pty"],
      global: true,
    });

    assert.deepStrictEqual(merged, ["foo", "node-pty"]);
    assert.deepStrictEqual(calls, [
      ["pnpm", ["config", "get", "--global", "onlyBuiltDependencies", "--json"]],
      ["pnpm", ["config", "set", "--global", "onlyBuiltDependencies", '["foo","node-pty"]']],
    ]);
  });

  it("skips pnpm config writes when node-pty is already allowed", async () => {
    const calls = [];
    const merged = await ensurePnpmOnlyBuiltDependencies({
      runCommand: async (command, args) => {
        calls.push([command, args]);
        return { success: true, code: 0, stdout: '"node-pty"', stderr: "" };
      },
      dependencies: ["node-pty"],
      global: true,
    });

    assert.deepStrictEqual(merged, ["node-pty"]);
    assert.deepStrictEqual(calls, [
      ["pnpm", ["config", "get", "--global", "onlyBuiltDependencies", "--json"]],
    ]);
  });

  it("ignores benign PTY EIO verification errors", () => {
    assert.equal(shouldIgnoreNodePtyVerificationErrorMessage("read EIO"), true);
    assert.equal(shouldIgnoreNodePtyVerificationErrorMessage("Error: read EIO"), true);
    assert.equal(shouldIgnoreNodePtyVerificationErrorMessage("spawn-helper missing"), false);
  });

  it("repairs missing spawn-helper execute permission before verification", () => {
    const chmodCalls = [];
    const helperInfo = ensureNodePtySpawnHelperExecutableForPackageDirectory({
      packageDirectory: "/tmp/conductor-cli",
      platform: "darwin",
      arch: "arm64",
      existsSync: (candidate) => candidate.endsWith("/prebuilds/darwin-arm64/spawn-helper"),
      statSync: () => ({ mode: 0o100644 }),
      chmodSync: (candidate, mode) => chmodCalls.push([candidate, mode]),
    });

    assert.deepStrictEqual(helperInfo, {
      helperPath: "/tmp/conductor-cli/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
      updated: true,
    });
    assert.deepStrictEqual(chmodCalls, [
      ["/tmp/conductor-cli/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper", 0o755],
    ]);
  });

  it("does not chmod spawn-helper when it is already executable", () => {
    const helperInfo = ensureNodePtySpawnHelperExecutableForPackageDirectory({
      packageDirectory: "/tmp/conductor-cli",
      platform: "darwin",
      arch: "arm64",
      existsSync: (candidate) => candidate.endsWith("/prebuilds/darwin-arm64/spawn-helper"),
      statSync: () => ({ mode: 0o100755 }),
      chmodSync: () => {
        throw new Error("chmod should not be called");
      },
    });

    assert.deepStrictEqual(helperInfo, {
      helperPath: "/tmp/conductor-cli/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
      updated: false,
    });
  });

  it("embeds the EIO ignore helper into the verification script", () => {
    const script = buildNodePtyVerificationScript();
    assert.match(script, /shouldIgnoreNodePtyVerificationErrorMessage/);
    assert.match(script, /read eio/i);
  });

  it("rebuilds pnpm native deps from the installed global package directory", async () => {
    const calls = [];
    const packageRoot = "/tmp/global/node_modules";
    const packageDirectory = `${packageRoot}/@love-moon/conductor-cli`;

    const result = await repairAndVerifyGlobalNodePty({
      packageManager: "pnpm",
      packageName: "@love-moon/conductor-cli",
      nodeExecutable: "/usr/bin/node",
      runCommand: async (command, args, options = {}) => {
        calls.push([command, args, options]);
        if (command === "pnpm" && args[0] === "config" && args[1] === "get") {
          return { success: true, code: 0, stdout: '"node-pty"', stderr: "" };
        }
        if (command === "pnpm" && args[0] === "root") {
          return { success: true, code: 0, stdout: `${packageRoot}\n`, stderr: "" };
        }
        if (command === "pnpm" && args[0] === "ignored-builds") {
          return { success: true, code: 0, stdout: "Automatically ignored builds during installation:\n  None\n", stderr: "" };
        }
        return { success: true, code: 0, stdout: "", stderr: "" };
      },
    });

    assert.strictEqual(result, packageDirectory);
    assert.deepStrictEqual(calls, [
      ["pnpm", ["config", "get", "--global", "onlyBuiltDependencies", "--json"], {}],
      ["pnpm", ["root", "-g"], {}],
      ["pnpm", ["ignored-builds"], { cwd: packageDirectory }],
      ["pnpm", ["rebuild", "node-pty"], { cwd: packageDirectory }],
      ["/usr/bin/node", ["-e", buildNodePtyVerificationScript(), packageDirectory], { timeoutMs: 15_000 }],
    ]);
  });

  it("fails pnpm repair when node-pty build scripts are still ignored", async () => {
    const packageRoot = "/tmp/global/node_modules";
    const packageDirectory = `${packageRoot}/@love-moon/conductor-cli`;

    await assert.rejects(
      repairAndVerifyGlobalNodePty({
        packageManager: "pnpm",
        packageName: "@love-moon/conductor-cli",
        nodeExecutable: "/usr/bin/node",
        runCommand: async (command, args) => {
          if (command === "pnpm" && args[0] === "config" && args[1] === "get") {
            return { success: true, code: 0, stdout: '"node-pty"', stderr: "" };
          }
          if (command === "pnpm" && args[0] === "root") {
            return { success: true, code: 0, stdout: `${packageRoot}\n`, stderr: "" };
          }
          if (command === "pnpm" && args[0] === "ignored-builds") {
            return {
              success: true,
              code: 0,
              stdout: "Automatically ignored builds during installation:\n  node-pty\n",
              stderr: "",
            };
          }
          return { success: true, code: 0, stdout: "", stderr: "" };
        },
      }),
      /pnpm ignored native build scripts for node-pty/,
    );
    assert.strictEqual(packageDirectory, "/tmp/global/node_modules/@love-moon/conductor-cli");
  });
});
