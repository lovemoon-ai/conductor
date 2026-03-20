import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OpencodeServerTransport } from "../src/transports/opencode-server-transport.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HANGING_PROCESS = path.resolve(__dirname, "..", "fixtures", "hanging-process.js");

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForCondition(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe("opencode server transport", () => {
  it("respects configured hostname and port flags without appending defaults", () => {
    const logs = [];
    const transport = new OpencodeServerTransport({
      cwd: process.cwd(),
      commandLine: "opencode serve --port 1234 --hostname 0.0.0.0",
      hostname: "127.0.0.1",
      port: 4321,
      logger: { log: (message) => logs.push(String(message)) },
    });

    assert.equal(transport.hostname, "0.0.0.0");
    assert.equal(transport.port, 1234);
    assert.deepEqual(transport.buildArgs(), ["serve", "--port", "1234", "--hostname", "0.0.0.0"]);
    assert.equal(
      logs.some((message) => message.includes("using configured --port 1234")),
      true,
    );
  });

  it("parses quoted command paths and args from an explicit commandLine", () => {
    const transport = new OpencodeServerTransport({
      cwd: process.cwd(),
      commandLine: "\"/Applications/Open Code/bin/opencode\" --flag=\"a b\" --label='two words'",
      logger: { log: () => {} },
    });

    assert.equal(transport.command, "/Applications/Open Code/bin/opencode");
    assert.deepEqual(transport.baseArgs, ["--flag=a b", "--label=two words"]);
  });

  it("falls back to CONDUCTOR_CLI_COMMAND when no explicit opencode command is supplied", () => {
    const originalCliCommand = process.env.CONDUCTOR_CLI_COMMAND;
    const originalOpencodeCommand = process.env.CONDUCTOR_OPENCODE_COMMAND;
    delete process.env.CONDUCTOR_OPENCODE_COMMAND;
    process.env.CONDUCTOR_CLI_COMMAND = "\"/custom/Open Code/bin/opencode\" --flag=\"a b\" --label='two words'";

    try {
      const transport = new OpencodeServerTransport({
        cwd: process.cwd(),
        logger: { log: () => {} },
      });

      assert.equal(transport.command, "/custom/Open Code/bin/opencode");
      assert.deepEqual(transport.baseArgs, ["--flag=a b", "--label=two words"]);
    } finally {
      if (originalOpencodeCommand === undefined) {
        delete process.env.CONDUCTOR_OPENCODE_COMMAND;
      } else {
        process.env.CONDUCTOR_OPENCODE_COMMAND = originalOpencodeCommand;
      }
      if (originalCliCommand === undefined) {
        delete process.env.CONDUCTOR_CLI_COMMAND;
      } else {
        process.env.CONDUCTOR_CLI_COMMAND = originalCliCommand;
      }
    }
  });

  it("cleans up boot state after spawn failures so later boots retry the process", async () => {
    const transport = new OpencodeServerTransport({
      cwd: process.cwd(),
      commandLine: "__missing_opencode_binary_for_test__",
      logger: { log: () => {} },
      timeout: 50,
    });

    await assert.rejects(() => transport.boot());
    assert.equal(transport.url, "");
    assert.equal(transport.child, null);
    assert.equal(transport.booted, false);

    await assert.rejects(() => transport.boot());
    assert.equal(transport.url, "");
    assert.equal(transport.child, null);
    assert.equal(transport.booted, false);
  });

  it("kills the timed-out child before allowing a retry on the same transport", async () => {
    const transport = new OpencodeServerTransport({
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${HANGING_PROCESS}`,
      logger: { log: () => {} },
      timeout: 50,
    });

    const firstBoot = transport.boot();
    await waitForCondition(() => Number.isInteger(transport.pid) && transport.pid > 0);
    const firstPid = transport.pid;
    assert.equal(isProcessAlive(firstPid), true);
    await assert.rejects(firstBoot, /Timed out waiting for opencode server/);
    assert.equal(transport.child, null);
    assert.equal(transport.booted, false);
    assert.equal(transport.url, "");
    assert.equal(isProcessAlive(firstPid), false);

    const secondBoot = transport.boot();
    await waitForCondition(() => Number.isInteger(transport.pid) && transport.pid > 0);
    const secondPid = transport.pid;
    assert.notEqual(secondPid, firstPid);
    assert.equal(isProcessAlive(secondPid), true);
    await assert.rejects(secondBoot, /Timed out waiting for opencode server/);
    assert.equal(transport.child, null);
    assert.equal(transport.booted, false);
    assert.equal(transport.url, "");
    assert.equal(isProcessAlive(secondPid), false);
  });
});
