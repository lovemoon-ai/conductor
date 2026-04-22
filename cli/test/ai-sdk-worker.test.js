import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { createAiSession, RemoteAiSession } from "@love-moon/ai-sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FAKE_CODEX_APP_SERVER = path.join(__dirname, "fixtures", "fake-codex-app-server.js");
const FAKE_OPENCODE_SERVER = path.resolve(
  __dirname,
  "..",
  "..",
  "modules",
  "ai-sdk",
  "fixtures",
  "fake-opencode-server.js",
);
const FAKE_KIMI_WIRE = path.resolve(
  __dirname,
  "..",
  "..",
  "modules",
  "ai-sdk",
  "fixtures",
  "fake-kimi-wire.js",
);
const FAKE_CODEX_EXEC = path.resolve(
  __dirname,
  "..",
  "..",
  "modules",
  "ai-sdk",
  "fixtures",
  "fake-codex-exec.js",
);
const FAKE_KIMI_PRINT = path.resolve(
  __dirname,
  "..",
  "..",
  "modules",
  "ai-sdk",
  "fixtures",
  "fake-kimi-print.js",
);
const DEFAULT_CONDUCTOR_CONFIG = process.env.CONDUCTOR_CONFIG;
const DEFAULT_CODEX_API_KEY = process.env.CODEX_API_KEY;

let isolatedConfigPath = null;

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 20 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(intervalMs);
  }
  throw new Error("Timed out waiting for condition");
}

beforeEach(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-sdk-worker-config-"));
  isolatedConfigPath = path.join(tempDir, "config.yaml");
  fs.writeFileSync(isolatedConfigPath, "allow_cli_list: {}\n", "utf8");
  process.env.CONDUCTOR_CONFIG = isolatedConfigPath;
  delete process.env.AISDK_PROVIDER_PATH;
});

afterEach(() => {
  delete process.env.AISDK_PROVIDER_PATH;
  if (DEFAULT_CODEX_API_KEY === undefined) {
    delete process.env.CODEX_API_KEY;
  } else {
    process.env.CODEX_API_KEY = DEFAULT_CODEX_API_KEY;
  }
  if (DEFAULT_CONDUCTOR_CONFIG === undefined) {
    delete process.env.CONDUCTOR_CONFIG;
  } else {
    process.env.CONDUCTOR_CONFIG = DEFAULT_CONDUCTOR_CONFIG;
  }
  if (isolatedConfigPath) {
    fs.rmSync(path.dirname(isolatedConfigPath), { recursive: true, force: true });
    isolatedConfigPath = null;
  }
});

describe("ai-sdk worker boundary", () => {
  it("creates worker-backed sessions by default", async () => {
    const session = createAiSession("codex", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_CODEX_APP_SERVER}`,
      logger: { log: () => {} },
    });

    assert.ok(session instanceof RemoteAiSession);
    await waitFor(() => session.getSnapshot().workerReady === true);
    assert.equal(session.getSnapshot().provider, "codex-app-server");

    await session.close();
  });

  it("omits CODEX_API_KEY from codex app-server child env when requested", async () => {
    process.env.CODEX_API_KEY = "sk-bad-codex-key";
    const session = createAiSession("codex", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_CODEX_APP_SERVER}`,
      ignoreCodexApiKey: true,
      logger: { log: () => {} },
    });

    try {
      assert.ok(session instanceof RemoteAiSession);
      await waitFor(() => session.getSnapshot().workerReady === true);
      assert.equal(session.getSnapshot().provider, "codex-app-server");

      const result = await session.runTurn("[env-check]");
      assert.equal(result.text, "CODEX_API_KEY=absent\n");
    } finally {
      await session.close();
    }
  });

  it("creates worker-backed claude sessions without booting a turn", async () => {
    const resumeSessionId = "11111111-1111-1111-1111-111111111111";
    const session = createAiSession("claude", {
      cwd: process.cwd(),
      resumeSessionId,
      logger: { log: () => {} },
    });

    assert.ok(session instanceof RemoteAiSession);
    await waitFor(() => session.getSnapshot().workerReady === true);
    assert.equal(session.getSnapshot().provider, "claude-agent-sdk");

    const sessionInfo = await session.ensureSessionInfo();
    assert.equal(sessionInfo.sessionId, resumeSessionId);
    assert.equal(session.threadOptions.model, "claude");

    await session.close();
  });

  it("creates worker-backed opencode sessions without booting a turn", async () => {
    const session = createAiSession("opencode", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_OPENCODE_SERVER}`,
      logger: { log: () => {} },
    });

    assert.ok(session instanceof RemoteAiSession);
    await waitFor(() => session.getSnapshot().workerReady === true);
    assert.equal(session.getSnapshot().provider, "opencode-sdk");

    const sessionInfo = await session.ensureSessionInfo();
    assert.ok(String(sessionInfo.sessionId).startsWith("session-fake-opencode-"));
    assert.equal(session.threadOptions.model, "opencode");

    await session.close();
  });

  it("creates worker-backed copilot sessions without booting a turn", async () => {
    const session = createAiSession("copilot", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });

    assert.ok(session instanceof RemoteAiSession);
    await waitFor(() => session.getSnapshot().workerReady === true);
    assert.equal(session.getSnapshot().provider, "copilot-sdk");
    assert.equal(session.threadOptions.model, "copilot");

    await session.close();
  });

  it("creates worker-backed kimi sessions without booting a turn", async () => {
    const session = createAiSession("kimi", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_KIMI_WIRE}`,
      logger: { log: () => {} },
    });

    assert.ok(session instanceof RemoteAiSession);
    await waitFor(() => session.getSnapshot().workerReady === true);
    assert.equal(session.getSnapshot().provider, "kimi-cli-wire");

    const sessionInfo = await session.ensureSessionInfo();
    assert.equal(sessionInfo.sessionId, session.getSnapshot().sessionId);
    assert.equal(session.threadOptions.model, "kimi");

    await session.close();
  });

  it("creates worker-backed codex exec sessions when structured output is requested", async () => {
    const session = createAiSession("codex", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_CODEX_EXEC}`,
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
        },
      },
      logger: { log: () => {} },
    });

    assert.ok(session instanceof RemoteAiSession);
    await waitFor(() => session.getSnapshot().workerReady === true);
    assert.equal(session.getSnapshot().provider, "codex-exec");

    const result = await session.runTurn("Reply with JSON", {
      jsonSchema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    });
    assert.equal(result.text, "{\"ok\":true}\n");

    await session.close();
  });

  it("omits CODEX_API_KEY from codex exec child env when requested", async () => {
    process.env.CODEX_API_KEY = "sk-bad-codex-key";
    const session = createAiSession("codex", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_CODEX_EXEC}`,
      ignoreCodexApiKey: true,
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
        },
      },
      logger: { log: () => {} },
    });

    try {
      assert.ok(session instanceof RemoteAiSession);
      await waitFor(() => session.getSnapshot().workerReady === true);
      assert.equal(session.getSnapshot().provider, "codex-exec");

      const result = await session.runTurn("Check env", {
        jsonSchema: {
          type: "object",
          properties: {
            codex_api_key_present: { type: "boolean" },
          },
          required: ["codex_api_key_present"],
          additionalProperties: false,
        },
      });
      assert.deepEqual(JSON.parse(result.text), {
        codex_api_key_present: false,
      });
    } finally {
      await session.close();
    }
  });

  it("sends codex exec prompts over stdin for image turns", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-exec-image-"));
    const imagePath = path.join(tempDir, "pixel.png");
    fs.writeFileSync(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmh0AAAAASUVORK5CYII=",
        "base64",
      ),
    );

    const session = createAiSession("codex", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_CODEX_EXEC}`,
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
        },
      },
      initialImages: [imagePath],
      logger: { log: () => {} },
    });

    try {
      assert.ok(session instanceof RemoteAiSession);
      await waitFor(() => session.getSnapshot().workerReady === true);
      assert.equal(session.getSnapshot().provider, "codex-exec");

      const result = await session.runTurn("Reply with JSON [images]", {
        useInitialImages: true,
        jsonSchema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
          },
          required: ["ok"],
          additionalProperties: false,
        },
      });
      assert.equal(result.text, "{\"ok\":true} [images:1]\n");
    } finally {
      await session.close().catch(() => {});
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates worker-backed kimi print sessions when structured output is requested", async () => {
    const session = createAiSession("kimi", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_KIMI_PRINT}`,
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
        },
      },
      logger: { log: () => {} },
    });

    assert.ok(session instanceof RemoteAiSession);
    await waitFor(() => session.getSnapshot().workerReady === true);
    assert.equal(session.getSnapshot().provider, "kimi-cli-print");

    const result = await session.runTurn("Reply with JSON", {
      jsonSchema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    });
    assert.equal(result.text, "Let me inspect the workspace.{\"ok\":true}\n");

    await session.close();
  });

  it("rejects unsupported backends at the ai-sdk boundary", async () => {
    const session = createAiSession("gemini", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });

    await assert.rejects(
      () => session.readyPromise,
      /Set AISDK_PROVIDER_PATH to load external providers/,
    );
  });

  it("runs codex turns through app-server and emits completed assistant messages", async () => {
    const session = createAiSession("codex", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_CODEX_APP_SERVER}`,
      logger: { log: () => {} },
    });
    const chunks = [];
    const statuses = [];

    session.setSessionMessageHandler(async (payload) => {
      chunks.push(payload);
    });
    session.setWorkingStatusHandler(async (payload) => {
      statuses.push(payload);
    });
    session.setSessionReplyTarget("reply-1");

    const sessionInfo = await session.ensureSessionInfo();
    assert.equal(sessionInfo.sessionId, "thread-fake-1");
    assert.equal(sessionInfo.sessionFilePath, "/tmp/thread-fake-1.jsonl");
    assert.equal(sessionInfo.model, "gpt-fake-codex");
    assert.equal(sessionInfo.modelProvider, "fake-provider");
    assert.equal(sessionInfo.reasoningEffort, "high");
    assert.equal(session.getSnapshot().provider, "codex-app-server");
    assert.equal(session.threadOptions.model, "gpt-fake-codex");
    assert.equal(session.threadOptions.modelProvider, "fake-provider");

    const result = await session.runTurn("Reply with exactly OK");
    assert.equal(result.text, "OK from fake codex\n");

    const usage = await session.getSessionUsageSummary();
    assert.equal(usage.sessionId, "thread-fake-1");
    assert.equal(usage.sessionFilePath, "/tmp/thread-fake-1.jsonl");
    assert.equal(usage.tokenUsagePercent, 23);
    assert.equal(usage.contextUsagePercent, 50);
    assert.equal(usage.manualResume.ready, true);
    assert.match(usage.manualResume.command, /^codex resume thread-fake-1$/);

    assert.equal(
      chunks.map((payload) => payload.text).join(""),
      "OK from fake codex\n",
    );
    assert.ok(chunks.every((payload) => payload.preserveWhitespace === true));
    assert.ok(chunks.every((payload) => payload.replyTo === "reply-1"));

    assert.ok(statuses.some((payload) => payload.phase === "turn_started"));
    assert.ok(statuses.some((payload) => payload.phase === "reasoning"));
    assert.ok(statuses.some((payload) => payload.phase === "planning"));
    assert.ok(statuses.some((payload) => payload.phase === "command_execution"));
    assert.ok(statuses.some((payload) => payload.phase === "message_aggregation"));
    assert.ok(statuses.some((payload) => payload.phase === "turn_completed"));
    assert.ok(statuses.some((payload) => payload.reply_in_progress === false));
    assert.ok(statuses.every((payload) => payload.source === "codex-app-server"));
    assert.ok(statuses.some((payload) => payload.status_line === "codex updating plan"));
    assert.ok(statuses.some((payload) => payload.status_line === "codex composing reply"));
    assert.ok(statuses.every((payload) => payload.status_line !== "codex item"));
    assert.deepEqual(session.threadOptions, {
      model: "gpt-fake-codex",
      modelProvider: "fake-provider",
    });

    await session.close();
  });

  it("surfaces current turn status while a worker-backed turn is still running", async () => {
    const session = createAiSession("codex", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_CODEX_APP_SERVER}`,
      logger: { log: () => {} },
    });

    await session.ensureSessionInfo();
    const turnPromise = session.runTurn("Reply with steady output [slow-progress]");

    await waitFor(() => {
      const status = session.getSnapshot().currentTurnStatus;
      return status?.reply_in_progress === true && typeof status?.phase === "string";
    }, { timeoutMs: 1000 });

    const midTurnStatus = session.getSnapshot().currentTurnStatus;
    assert.equal(midTurnStatus.reply_in_progress, true);
    assert.equal(typeof midTurnStatus.phase, "string");
    assert.equal(typeof midTurnStatus.updated_at, "string");

    const result = await turnPromise;
    assert.equal(result.text, "still making steady progress from fake codex\n");

    const finalStatus = session.getSnapshot().currentTurnStatus;
    assert.equal(finalStatus.reply_in_progress, false);
    assert.equal(finalStatus.phase, "turn_completed");
    assert.equal(typeof finalStatus.updated_at, "string");

    await session.close();
  });

  it("keeps multiple codex assistant messages separated within one turn", async () => {
    const session = createAiSession("codex", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_CODEX_APP_SERVER}`,
      logger: { log: () => {} },
    });
    const chunks = [];

    session.setSessionMessageHandler(async (payload) => {
      chunks.push(payload);
    });
    session.setSessionReplyTarget("reply-2");

    await session.ensureSessionInfo();

    const result = await session.runTurn("Reply with two messages [multi-message]");
    assert.equal(result.text, "开始计时 2 分钟。完成");
    assert.deepEqual(
      chunks.map((payload) => payload.text),
      ["开始计时 2 分钟。", "完成"],
    );
    assert.ok(chunks.every((payload) => payload.replyTo === "reply-2"));

    await session.close();
  });

  it("resumes codex threads through app-server when a session id is supplied", async () => {
    const session = createAiSession("codex", {
      cwd: process.cwd(),
      resumeSessionId: "thread-resume-42",
      commandLine: `${process.execPath} ${FAKE_CODEX_APP_SERVER}`,
      logger: { log: () => {} },
    });

    const sessionInfo = await session.ensureSessionInfo();
    assert.equal(sessionInfo.sessionId, "thread-resume-42");
    assert.equal(session.getSnapshot().sessionId, "thread-resume-42");

    await session.close();
  });

  it("runs opencode turns through the local server and emits assistant messages", async () => {
    const session = createAiSession("opencode", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_OPENCODE_SERVER}`,
      logger: { log: () => {} },
    });
    const chunks = [];
    const statuses = [];

    session.setSessionMessageHandler(async (payload) => {
      chunks.push(payload);
    });
    session.setWorkingStatusHandler(async (payload) => {
      statuses.push(payload);
    });
    session.setSessionReplyTarget("reply-opencode-worker-1");

    const sessionInfo = await session.ensureSessionInfo();
    assert.ok(String(sessionInfo.sessionId).startsWith("session-fake-opencode-"));
    assert.equal(session.getSnapshot().provider, "opencode-sdk");

    const result = await session.runTurn("Reply with exactly OK");
    assert.equal(result.text, "OK from fake opencode\n");

    assert.deepEqual(
      chunks.map((payload) => payload.text),
      ["OK from fake opencode\n"],
    );
    assert.ok(chunks.every((payload) => payload.replyTo === "reply-opencode-worker-1"));
    assert.ok(statuses.some((payload) => payload.phase === "reasoning"));
    assert.ok(statuses.some((payload) => payload.phase === "planning"));
    assert.ok(statuses.some((payload) => payload.phase === "command_execution"));
    assert.ok(statuses.some((payload) => payload.phase === "message_aggregation"));
    assert.ok(statuses.some((payload) => payload.phase === "turn_completed"));
    assert.ok(statuses.some((payload) => payload.reply_in_progress === false));
    assert.ok(statuses.every((payload) => payload.source === "opencode-sdk"));

    await session.close();
  });

  it("runs kimi turns through wire mode and emits assistant messages", async () => {
    const session = createAiSession("kimi", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_KIMI_WIRE}`,
      logger: { log: () => {} },
    });
    const chunks = [];
    const statuses = [];

    session.setSessionMessageHandler(async (payload) => {
      chunks.push(payload);
    });
    session.setWorkingStatusHandler(async (payload) => {
      statuses.push(payload);
    });
    session.setSessionReplyTarget("reply-kimi-worker-1");

    const sessionInfo = await session.ensureSessionInfo();
    assert.equal(sessionInfo.sessionId, session.getSnapshot().sessionId);
    assert.equal(session.getSnapshot().provider, "kimi-cli-wire");

    const result = await session.runTurn("Reply with exactly OK");
    assert.equal(result.text, "OK from fake kimi\n");

    assert.deepEqual(
      chunks.map((payload) => payload.text),
      ["OK from fake kimi\n"],
    );
    assert.ok(chunks.every((payload) => payload.replyTo === "reply-kimi-worker-1"));
    assert.ok(statuses.some((payload) => payload.phase === "reasoning"));
    assert.ok(statuses.some((payload) => payload.phase === "command_execution"));
    assert.ok(statuses.some((payload) => payload.phase === "message_aggregation"));
    assert.ok(statuses.some((payload) => payload.phase === "turn_completed"));
    assert.ok(statuses.every((payload) => payload.source === "kimi-cli-wire"));

    const usage = await session.getSessionUsageSummary();
    assert.equal(usage.sessionId, sessionInfo.sessionId);
    assert.equal(usage.contextUsagePercent, 57);

    await session.close();
  });
});
