import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { BridgeRunner } from "../bin/conductor-fire.js";

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await delay(5);
  }
}

function createRunner({ backendSession, statuses }) {
  const runner = new BridgeRunner({
    backendSession: {
      threadId: "thread-1",
      threadOptions: { model: "claude" },
      ...backendSession,
    },
    conductor: {
      sendRuntimeStatus: async (_taskId, payload) => {
        statuses.push(payload);
      },
      sendMessage: async () => ({}),
    },
    taskId: "task-heartbeat",
    pollIntervalMs: 500,
    initialPrompt: "",
    includeInitialImages: false,
    cliArgs: [],
    backendName: "claude",
  });
  runner.runtimeHeartbeatMs = 30;
  return runner;
}

const longToolStatus = () => ({
  reply_in_progress: true,
  phase: "command_execution",
  status_line: "claude running command",
  replyTo: "msg-1",
  active_tool: {
    name: "Bash",
    summary: "pnpm test",
    started_at: new Date(Date.now() - 125_000).toISOString(),
  },
});

describe("fire runtime heartbeat", () => {
  it("reports the running tool on every silent interval until the turn ends", async () => {
    const statuses = [];
    let finishTurn;
    let statusQueries = 0;
    const runner = createRunner({
      statuses,
      backendSession: {
        runTurn: () =>
          new Promise((resolve) => {
            finishTurn = resolve;
          }),
        fetchCurrentTurnStatus: async () => {
          statusQueries += 1;
          return longToolStatus();
        },
      },
    });

    const respondPromise = runner.respondToMessage({ message_id: "msg-1", role: "user", content: "run tests" });
    await waitFor(() => statuses.filter((status) => status.phase === "command_execution").length >= 2);

    const heartbeat = statuses.find((status) => status.phase === "command_execution");
    assert.equal(heartbeat.reply_in_progress, true);
    assert.equal(heartbeat.reply_to, "msg-1");
    assert.equal(heartbeat.status_line, "claude running Bash (2m): pnpm test");

    finishTurn({ text: "done", items: [], usage: null, metadata: {} });
    await respondPromise;
    const queriesAtTurnEnd = statusQueries;
    await delay(100);
    assert.equal(statusQueries, queriesAtTurnEnd, "heartbeat must stop once the turn ends");
    assert.equal(statuses.at(-1).reply_in_progress, false);
  });

  it("does not re-open a turn the provider already settled", async () => {
    const statuses = [];
    let finishTurn;
    const runner = createRunner({
      statuses,
      backendSession: {
        runTurn: () =>
          new Promise((resolve) => {
            finishTurn = resolve;
          }),
        fetchCurrentTurnStatus: async () => ({ reply_in_progress: false, phase: "turn_completed" }),
      },
    });

    const respondPromise = runner.respondToMessage({ message_id: "msg-1", role: "user", content: "hi" });
    await delay(120);
    assert.equal(statuses.some((status) => status.phase === "turn_completed"), false);

    finishTurn({ text: "done", items: [], usage: null, metadata: {} });
    await respondPromise;
  });

  it("drops a heartbeat when a newer frame was sent while querying the session", async () => {
    const statuses = [];
    let releaseQuery;
    const runner = createRunner({
      statuses,
      backendSession: {
        fetchCurrentTurnStatus: () =>
          new Promise((resolve) => {
            releaseQuery = () => resolve(longToolStatus());
          }),
      },
    });
    runner.runtimeHeartbeatMs = 60_000;
    runner.runningTurn = true;

    const heartbeat = runner.reportRuntimeHeartbeat();
    await waitFor(() => typeof releaseQuery === "function");
    await runner.reportRuntimeStatus({ phase: "turn_completed", reply_in_progress: false, status_done_line: "claude finished" }, "msg-1");
    releaseQuery();
    await heartbeat;

    assert.deepEqual(statuses.map((status) => status.reply_in_progress), [false]);
    runner.runningTurn = false;
    runner.scheduleRuntimeHeartbeat();
  });

  it("falls back to the pushed status when the session cannot be queried", async () => {
    const runner = createRunner({
      statuses: [],
      backendSession: {
        getCurrentTurnStatus: () => ({ reply_in_progress: true, status_line: "codex is thinking" }),
      },
    });
    runner.turnStartedAt = Date.now() - 42_000;

    const status = await runner.fetchBackendTurnStatus();
    assert.equal(runner.formatRuntimeHeartbeatLine(status), "codex is thinking (42s)");
  });

  it("keeps the heartbeat line within the status pill", () => {
    const runner = createRunner({ statuses: [], backendSession: {} });
    const line = runner.formatRuntimeHeartbeatLine({
      active_tool: {
        name: "Bash",
        summary: `pnpm vitest run ${"src/very/long/path/".repeat(12)}`,
        started_at: new Date(Date.now() - 3_720_000).toISOString(),
      },
    });
    assert.equal(line.length, 100);
    assert.match(line, /^claude running Bash \(1h 2m\): pnpm vitest run src\/very.*…$/);
  });

  it("answers an app refresh request immediately with a forced heartbeat", async () => {
    const statuses = [];
    const runner = createRunner({
      statuses,
      backendSession: { fetchCurrentTurnStatus: async () => longToolStatus() },
    });
    runner.runtimeHeartbeatMs = 60_000;
    runner.runningTurn = true;

    await runner.requestRuntimeStatusFromRemote({ taskId: "task-heartbeat" });
    await runner.requestRuntimeStatusFromRemote({ taskId: "task-heartbeat" });
    await runner.requestRuntimeStatusFromRemote({ taskId: "other-task" });

    assert.equal(statuses.length, 2, "identical refresh answers are not deduplicated");
    assert.equal(statuses[1].status_line, "claude running Bash (2m): pnpm test");
    runner.runningTurn = false;
    runner.scheduleRuntimeHeartbeat();
  });

  it("does not let an unchanged provider status replace the heartbeat line", async () => {
    const statuses = [];
    const runner = createRunner({
      statuses,
      backendSession: { fetchCurrentTurnStatus: async () => longToolStatus() },
    });
    runner.runtimeHeartbeatMs = 60_000;
    runner.runningTurn = true;
    const providerStatus = { phase: "command_execution", reply_in_progress: true, status_line: "claude running command" };

    await runner.reportRuntimeStatus(providerStatus, "msg-1");
    await runner.requestRuntimeStatusFromRemote({ taskId: "task-heartbeat" });
    await runner.reportRuntimeStatus(providerStatus, "msg-1");

    assert.deepEqual(
      statuses.map((status) => status.status_line),
      ["claude running command", "claude running Bash (2m): pnpm test"],
    );
    runner.runningTurn = false;
    runner.scheduleRuntimeHeartbeat();
  });

  it("settles a stale in-progress status when the app asks and no turn is running", async () => {
    const statuses = [];
    const runner = createRunner({ statuses, backendSession: {} });
    runner.lastRuntimeStatusPayload = {
      state: "RUNNING",
      reply_in_progress: true,
      status_line: "claude running command",
      status_done_line: undefined,
      reply_to: "msg-1",
    };

    await runner.requestRuntimeStatusFromRemote({ taskId: "task-heartbeat" });

    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].reply_in_progress, false);
    assert.equal(statuses[0].status_line, undefined);
  });
});
