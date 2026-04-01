import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { CodexAppServerSession } from "../../modules/ai-sdk/src/providers/codex-app-server-session.js";
import { KimiCliSession } from "../../modules/ai-sdk/src/providers/kimi-cli-session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FAKE_CODEX_APP_SERVER = path.join(__dirname, "fixtures", "fake-codex-app-server.js");

const sessionsToClose = [];

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(intervalMs);
  }
  throw new Error("Timed out waiting for condition");
}

afterEach(async () => {
  while (sessionsToClose.length > 0) {
    const session = sessionsToClose.pop();
    try {
      await session.close();
    } catch {
      // best effort
    }
  }
});

describe("ai-sdk turn status and deadline", () => {
  it("keeps long-running turns alive while progress is still arriving", async () => {
    const session = new CodexAppServerSession("codex", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_CODEX_APP_SERVER}`,
      logger: { log: () => {} },
    });
    sessionsToClose.push(session);
    session.turnDeadlineMs = 50;

    await session.ensureSessionInfo();
    const turnPromise = session.runTurn("Reply with steady output [slow-progress]");

    await waitFor(() => session.getCurrentTurnStatus()?.reply_in_progress === true, { timeoutMs: 1000 });
    const midTurnStatus = session.getCurrentTurnStatus();
    assert.equal(midTurnStatus.reply_in_progress, true);
    assert.equal(typeof midTurnStatus.phase, "string");

    const result = await turnPromise;
    assert.equal(result.text, "still making steady progress from fake codex\n");

    const finalStatus = session.getCurrentTurnStatus();
    assert.equal(finalStatus.reply_in_progress, false);
    assert.equal(finalStatus.phase, "turn_completed");
  });

  it("still times out when a turn stops making progress", async () => {
    const session = new CodexAppServerSession("codex", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_CODEX_APP_SERVER}`,
      logger: { log: () => {} },
    });
    sessionsToClose.push(session);
    session.turnDeadlineMs = 50;

    await session.ensureSessionInfo();

    await assert.rejects(
      () => session.runTurn("Reply after stalling [slow-stall]"),
      /Turn exceeded hard deadline \(0s\)|Turn exceeded hard deadline \(1s\)/,
    );

    const finalStatus = session.getCurrentTurnStatus();
    assert.equal(finalStatus.reply_in_progress, false);
    assert.equal(finalStatus.phase, "turn_failed");
  });

  it("marks a new turn as started before downstream provider events arrive", async () => {
    const session = new CodexAppServerSession("codex", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_CODEX_APP_SERVER}`,
      logger: { log: () => {} },
    });
    sessionsToClose.push(session);

    await session.ensureSessionInfo();
    const firstTurn = await session.runTurn("Reply with exactly OK");
    assert.equal(firstTurn.text, "OK from fake codex\n");
    assert.equal(session.getCurrentTurnStatus()?.phase, "turn_completed");

    const secondTurnPromise = session.runTurn("Reply with steady output [slow-progress]");
    const immediateStatus = session.getCurrentTurnStatus();
    assert.equal(immediateStatus?.reply_in_progress, true);
    assert.equal(immediateStatus?.phase, "turn_started");

    await secondTurnPromise;
  });

  it("refreshes kimi updated_at even when duplicate working status payloads are suppressed", async () => {
    let nowMs = Date.parse("2026-04-01T00:00:00.000Z");
    const session = new KimiCliSession("kimi", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      now: () => nowMs,
    });
    sessionsToClose.push(session);

    await session.emitWorkingStatus({
      phase: "reasoning",
      reply_in_progress: true,
      status_line: "Kimi is thinking",
    });
    const firstStatus = session.getCurrentTurnStatus();
    assert.equal(firstStatus?.updated_at, "2026-04-01T00:00:00.000Z");

    nowMs += 50;
    await session.emitWorkingStatus({
      phase: "reasoning",
      reply_in_progress: true,
      status_line: "Kimi is thinking",
    });
    const secondStatus = session.getCurrentTurnStatus();
    assert.equal(secondStatus?.updated_at, "2026-04-01T00:00:00.050Z");
    assert.equal(secondStatus?.phase, "reasoning");
  });

  it("settles startup failures into turn_failed after publishing turn_started", async () => {
    const session = new CodexAppServerSession("codex", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });
    sessionsToClose.push(session);
    session.boot = async () => {
      throw new Error("boot failed");
    };

    await assert.rejects(() => session.runTurn("Reply with exactly OK"), /boot failed/);

    const finalStatus = session.getCurrentTurnStatus();
    assert.equal(finalStatus?.reply_in_progress, false);
    assert.equal(finalStatus?.phase, "turn_failed");
    assert.equal(finalStatus?.status_done_line, "boot failed");
  });
});
