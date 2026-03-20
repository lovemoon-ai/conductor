import { describe, it } from "node:test";
import assert from "node:assert/strict";
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

  it("rejects unsupported backends at the ai-sdk boundary", async () => {
    assert.throws(
      () =>
        createAiSession("gemini", {
          cwd: process.cwd(),
          logger: { log: () => {} },
        }),
      /Only codex app-server, claude agent-sdk, and opencode sdk are supported/,
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
    assert.equal(session.getSnapshot().provider, "codex-app-server");

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
});
