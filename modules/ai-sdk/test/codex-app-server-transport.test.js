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
});
