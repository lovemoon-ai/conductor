import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ensurePnpmOnlyBuiltDependencies,
  mergeBuiltDependencies,
  normalizeBuiltDependencyList,
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
});
