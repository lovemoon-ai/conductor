import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAppServerTransport } from "../src/transports/codex-app-server-transport.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FAKE_CODEX_APP_SERVER = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "cli",
  "test",
  "fixtures",
  "fake-codex-app-server.js",
);

describe("codex app-server transport", () => {
  it("spawns the app-server with PWD aligned to the requested cwd", async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-server-cwd-"));
    const transport = new CodexAppServerTransport({
      cwd: targetDir,
      commandLine: `${process.execPath} ${FAKE_CODEX_APP_SERVER}`,
      logger: { log: () => {} },
    });

    try {
      const result = await transport.request("thread/start", { cwd: targetDir });
      assert.equal(fs.realpathSync(result?.thread?.processCwd), fs.realpathSync(targetDir));
      assert.equal(fs.realpathSync(result?.thread?.pwdEnv), fs.realpathSync(targetDir));
    } finally {
      await transport.close();
    }
  });

  it("injects --enable goals before --listen when enableGoals is true", () => {
    const transport = new CodexAppServerTransport({
      cwd: process.cwd(),
      commandLine: "codex app-server --listen stdio://",
      enableGoals: true,
      logger: { log: () => {} },
    });
    assert.deepEqual(transport.args, ["app-server", "--enable", "goals", "--listen", "stdio://"]);
    assert.equal(transport.enableGoals, true);
  });

  it("leaves spawn args unchanged when enableGoals is not set", () => {
    const transport = new CodexAppServerTransport({
      cwd: process.cwd(),
      commandLine: "codex app-server --listen stdio://",
      logger: { log: () => {} },
    });
    assert.deepEqual(transport.args, ["app-server", "--listen", "stdio://"]);
    assert.equal(transport.enableGoals, false);
  });

  it("does not duplicate --enable goals when already present in commandLine", () => {
    const transport = new CodexAppServerTransport({
      cwd: process.cwd(),
      commandLine: "codex app-server --enable goals --listen stdio://",
      enableGoals: true,
      logger: { log: () => {} },
    });
    assert.deepEqual(transport.args, ["app-server", "--enable", "goals", "--listen", "stdio://"]);
  });

  it("does not duplicate when commandLine already passes --enable=goals (equals form)", () => {
    const transport = new CodexAppServerTransport({
      cwd: process.cwd(),
      commandLine: "codex app-server --enable=goals --listen stdio://",
      enableGoals: true,
      logger: { log: () => {} },
    });
    assert.deepEqual(transport.args, ["app-server", "--enable=goals", "--listen", "stdio://"]);
  });

  it("does not duplicate when commandLine passes --enable=goals,foo comma list", () => {
    const transport = new CodexAppServerTransport({
      cwd: process.cwd(),
      commandLine: "codex app-server --enable=goals,otherflag --listen stdio://",
      enableGoals: true,
      logger: { log: () => {} },
    });
    assert.deepEqual(transport.args, [
      "app-server",
      "--enable=goals,otherflag",
      "--listen",
      "stdio://",
    ]);
  });

  it("still injects --enable goals when commandLine has --enable=other (no goals)", () => {
    const transport = new CodexAppServerTransport({
      cwd: process.cwd(),
      commandLine: "codex app-server --enable=other --listen stdio://",
      enableGoals: true,
      logger: { log: () => {} },
    });
    assert.deepEqual(transport.args, [
      "app-server",
      "--enable=other",
      "--enable",
      "goals",
      "--listen",
      "stdio://",
    ]);
  });

  it("appends --enable goals when --listen is absent", () => {
    const transport = new CodexAppServerTransport({
      cwd: process.cwd(),
      commandLine: "codex app-server",
      enableGoals: true,
      logger: { log: () => {} },
    });
    assert.deepEqual(transport.args, ["app-server", "--enable", "goals"]);
  });
});
