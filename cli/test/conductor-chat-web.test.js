import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runChatWebCommand } from "../bin/conductor-chat-web.js";
import { runConductorCli } from "../bin/conductor.js";

describe("conductor browser chat entry", () => {
  it("consumes the wrapper separator before the packaged CLI command", async () => {
    const original = process.argv;
    try {
      await runChatWebCommand(["--", "runtime", "status"], {
        env: { HOME: "/nonexistent-chat-web-test" }, chatWebModule: {}, cliEntry: "/fixture/cli.js",
        importCli: async () => { assert.deepEqual(process.argv.slice(2), ["runtime", "status"]); },
      });
    } finally { process.argv = original; }
  });

  it("preserves chat text following the option separator", async () => {
    const original = process.argv;
    try {
      await runChatWebCommand(["chat", "send", "chat-id", "--", "--config-file=literal-message"], {
        env: { HOME: "/nonexistent-chat-web-test" }, chatWebModule: {}, cliEntry: "/fixture/cli.js",
        importCli: async () => { assert.deepEqual(process.argv.slice(2), ["chat", "send", "chat-id", "--", "--config-file=literal-message"]); },
      });
    } finally { process.argv = original; }
  });

  it("uses the daemon's configured browser home while respecting shell overrides", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-browser-config-"));
    const config = path.join(directory, "config.yaml");
    fs.writeFileSync(config, "envs:\n  CHAT_WEB_HOME: /configured/browser\n  CHAT_WEB_BROWSER_CHANNEL: chrome\n  unrelated_secret: should-not-copy\n");
    const env = { CHAT_WEB_BROWSER_CHANNEL: "chromium" };
    try {
      await runChatWebCommand(["login", "kimi", "--config-file", config], {
        env, log() {},
        chatWebModule: { RuntimeChatSession: { open() {} }, registerBuiltinProviders() {}, async login() {
          assert.equal(env.CHAT_WEB_HOME, "/configured/browser");
          assert.equal(env.CHAT_WEB_BROWSER_CHANNEL, "chromium");
          assert.equal(env.unrelated_secret, undefined);
        } },
      });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("routes the login command through the installed chat-web SDK", async () => {
    const calls = [];
    assert.equal(await runChatWebCommand(["login", "deepseek"], {
      env: { HOME: "/nonexistent-chat-web-test" }, chatWebModule: { RuntimeChatSession: { open() {} }, registerBuiltinProviders() { calls.push("register"); }, async login(provider, options) { calls.push({ provider, options }); } },
      log() {},
    }), 0);
    assert.deepEqual(calls, ["register", { provider: "deepseek", options: { autoExit: true } }]);
    await assert.rejects(runChatWebCommand(["login", "typo"], { env: { HOME: "/nonexistent-chat-web-test" }, chatWebModule: {}, log() {} }), /kimi\|deepseek/);
  });
  it("dispatches conductor chat-web and keeps its arguments", () => {
    const original = process.argv;
    const imports = [];
    try {
      const result = runConductorCli(["chat-web", "login", "kimi"], { env: {}, processArgv: ["node", "/mock/conductor.js"], existsSync: () => true, maybeCheckForUpdates: async () => {}, importModule: async p => { imports.push(p); } });
      assert.equal(result.shouldExit, false);
      assert.match(imports[0], /conductor-chat-web\.js$/);
      assert.deepEqual(process.argv.slice(2), ["login", "kimi"]);
    } finally { process.argv = original; }
  });
});
