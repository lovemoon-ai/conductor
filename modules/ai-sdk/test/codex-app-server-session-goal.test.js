import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAppServerSession } from "../src/providers/codex-app-server-session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FAKE_CODEX_APP_SERVER_GOALS = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "fake-codex-app-server-goals.js",
);

function makeSession({ enableGoals = true, goalMode = true } = {}) {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-goal-session-"));
  // Provide the --enable goals flag explicitly via the commandLine when
  // requested so the fake script knows the feature is "on".
  const commandLine = enableGoals
    ? `${process.execPath} ${FAKE_CODEX_APP_SERVER_GOALS} --enable goals --listen stdio://`
    : `${process.execPath} ${FAKE_CODEX_APP_SERVER_GOALS} --listen stdio://`;
  const session = new CodexAppServerSession("codex", {
    cwd: targetDir,
    goalMode,
    commandLine,
    logger: { log: () => {} },
  });
  return { session, targetDir };
}

describe("codex app-server session - goal mode", () => {
  it("runGoal sends thread/goal/set and resolves on terminal goal status", async () => {
    const { session } = makeSession();
    try {
      const result = await session.runGoal({
        objective: "drive the release",
        tokenBudget: 1000,
      });
      assert.equal(result.goal.objective, "drive the release");
      assert.equal(result.goal.status, "complete");
      assert.equal(result.goal.tokenBudget, 1000);
      assert.equal(typeof result.goal.threadId, "string");
      assert.equal(result.text.includes("working on goal"), true);
      assert.equal(result.metadata.goalCleared, false);
    } finally {
      await session.close();
    }
  });

  it("runGoal resolves with full text when thread/goal/updated arrives AFTER turn/completed (C1)", async () => {
    process.env.FAKE_CODEX_GOAL_UPDATE_AFTER_TURN = "1";
    const { session } = makeSession();
    try {
      const result = await session.runGoal({ objective: "race window" });
      assert.equal(result.goal.status, "complete");
      // The per-turn text must survive the per-turn reset and end up in the
      // goal-aggregated `text` field.
      assert.ok(
        /working on goal/.test(result.text),
        `expected aggregated text to contain per-turn output, got ${JSON.stringify(result.text)}`,
      );
    } finally {
      delete process.env.FAKE_CODEX_GOAL_UPDATE_AFTER_TURN;
      await session.close();
    }
  });

  it("multi-turn goal aggregates text across turns and completes (C2 happy path)", async () => {
    process.env.FAKE_CODEX_GOAL_TURN_COUNT = "2";
    const { session } = makeSession();
    try {
      const result = await session.runGoal({ objective: "two-step" });
      assert.equal(result.goal.status, "complete");
      // Both turns' deltas must appear in the final aggregated text.
      assert.ok(
        /working on goal turn 1/.test(result.text),
        `missing turn 1 text in ${JSON.stringify(result.text)}`,
      );
      assert.ok(
        /working on goal turn 2/.test(result.text),
        `missing turn 2 text in ${JSON.stringify(result.text)}`,
      );
    } finally {
      delete process.env.FAKE_CODEX_GOAL_TURN_COUNT;
      await session.close();
    }
  });

  it("multi-turn goal preserves a delta that races BEFORE turn/started (C2)", async () => {
    process.env.FAKE_CODEX_GOAL_TURN_COUNT = "2";
    process.env.FAKE_CODEX_GOAL_DELTA_BEFORE_START = "1";
    const { session } = makeSession();
    try {
      const result = await session.runGoal({ objective: "delta-race" });
      assert.equal(result.goal.status, "complete");
      assert.ok(
        /working on goal turn 2/.test(result.text),
        `delta queued before turn/started was dropped: ${JSON.stringify(result.text)}`,
      );
    } finally {
      delete process.env.FAKE_CODEX_GOAL_TURN_COUNT;
      delete process.env.FAKE_CODEX_GOAL_DELTA_BEFORE_START;
      await session.close();
    }
  });

  it("runGoal rejects when a runTurn is already in flight", async () => {
    const { session } = makeSession();
    try {
      await session.boot();
      // Install a fake currentTurn to simulate an in-flight runTurn.
      session.currentTurn = {
        turnId: "",
        fullText: "",
        activeAssistantMessageId: "",
        activeAssistantMessageText: "",
        resolve: () => {},
        reject: () => {},
      };
      await assert.rejects(
        () => session.runGoal({ objective: "queued" }),
        (error) => error?.reason === "turn_already_running",
      );
    } finally {
      session.currentTurn = null;
      await session.close();
    }
  });

  it("getGoal preserves in-memory currentGoal when transport returns a null payload (I5)", async () => {
    process.env.FAKE_CODEX_GOAL_GET_NULL = "1";
    const { session } = makeSession();
    try {
      await session.boot();
      // Seed an in-memory current goal.
      const seeded = {
        id: "goal-pre",
        threadId: session.sessionId || undefined,
        objective: "pre-seeded",
        status: "active",
        tokenBudget: 999,
      };
      session.currentGoal = seeded;
      const result = await session.getGoal();
      assert.deepEqual(result, seeded);
      assert.deepEqual(session.currentGoal, seeded);
    } finally {
      delete process.env.FAKE_CODEX_GOAL_GET_NULL;
      await session.close();
    }
  });

  it("runGoal resolves when thread/goal/cleared arrives", async () => {
    const { session } = makeSession();
    process.env.FAKE_CODEX_GOAL_CLEAR = "1";
    try {
      const result = await session.runGoal({ objective: "wrap it up" });
      assert.equal(result.metadata.goalCleared, true);
      // Status defaults to whatever the last update was — cleared payloads
      // are mapped through the latest known goal state.
      assert.equal(typeof result.goal.status, "string");
    } finally {
      delete process.env.FAKE_CODEX_GOAL_CLEAR;
      await session.close();
    }
  });

  it("runGoal surfaces a goals_feature_disabled error when the server rejects the request", async () => {
    // Spawn without --enable goals on the args so the fake server returns
    // "goals feature is disabled" from thread/goal/set.
    const { session } = makeSession({ enableGoals: false, goalMode: false });
    try {
      await assert.rejects(
        () => session.runGoal({ objective: "won't start" }),
        (error) =>
          error?.reason === "goals_feature_disabled" &&
          /goals feature is disabled/i.test(String(error?.message || "")) &&
          /goalMode/.test(String(error?.message || "")),
      );
    } finally {
      await session.close();
    }
  });

  it("getGoal / clearGoal round-trip", async () => {
    const { session } = makeSession();
    try {
      // Run a goal so the fake server has state, then clear it.
      await session.runGoal({ objective: "round-trip" });
      const cleared = await session.clearGoal();
      assert.equal(cleared, true);
      const after = await session.getGoal();
      assert.equal(after, null);
    } finally {
      await session.close();
    }
  });

  it("runGoal rejects empty objectives", async () => {
    const { session } = makeSession();
    try {
      await assert.rejects(() => session.runGoal({ objective: "" }), /non-empty objective/);
    } finally {
      await session.close();
    }
  });

  it("runGoal resolves promptly when clearGoal is invoked externally mid-run", async () => {
    // Reproduces the hang described in the second-pass review: without the
    // fix, the goal-run waits for a thread/goal/cleared notification that
    // the server never sends (because the clear was client-initiated), and
    // ultimately rejects only on the turn timeout. With the fix, clearGoal
    // wakes the pending currentGoalRun directly.
    process.env.FAKE_CODEX_GOAL_HOLD_OPEN = "1";
    const { session } = makeSession();
    try {
      const goalPromise = session.runGoal({ objective: "hang-then-clear" });
      // Let runGoal dispatch thread/goal/set before we clear.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const cleared = await session.clearGoal();
      assert.equal(cleared, true);
      // Apply a hard ceiling so a regression manifests as a test timeout
      // (rather than the whole suite hanging on the turn-timeout default).
      const result = await Promise.race([
        goalPromise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("runGoal did not resolve within 1s after clearGoal")),
            1000,
          ),
        ),
      ]);
      assert.equal(result.metadata.goalCleared, true);
      assert.equal(typeof result.goal.status, "string");
    } finally {
      delete process.env.FAKE_CODEX_GOAL_HOLD_OPEN;
      await session.close();
    }
  });

  it("runGoal rejects with transport_exited when the codex transport dies mid-goal", async () => {
    // The fake server acks thread/goal/set then immediately calls
    // process.exit(1) without emitting any thread/goal/* notification.
    // handleTransportExit -> handleTransportFailure -> goalRun.handleTurnFailed
    // must reject the in-flight runGoal with reason="transport_exited".
    process.env.FAKE_CODEX_GOAL_EXIT_AFTER_SET = "1";
    const { session } = makeSession();
    try {
      await assert.rejects(
        () =>
          Promise.race([
            session.runGoal({ objective: "die-mid-flight" }),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("runGoal did not reject within 2s of transport exit")),
                2000,
              ),
            ),
          ]),
        (error) => error?.reason === "transport_exited",
      );
    } finally {
      delete process.env.FAKE_CODEX_GOAL_EXIT_AFTER_SET;
      await session.close();
    }
  });
});

describe("provider runGoal capability detection", () => {
  it("CodexAppServerSession exposes runGoal and declares goal capability", () => {
    const { session } = makeSession();
    assert.equal(typeof session.runGoal, "function");
    assert.equal(typeof session.getGoal, "function");
    assert.equal(typeof session.clearGoal, "function");
    assert.equal(typeof session.getCapabilities, "function");
    assert.equal(session.getCapabilities().goal, true);
    const snapshot = session.getSnapshot();
    assert.equal(snapshot.capabilities?.goal, true);
    // intentionally do not await; we just want the typeof check
    session.close();
  });

  it("providers that do not implement goals leave runGoal undefined", async () => {
    const { CodexExecSession, CopilotSdkSession, OpencodeSdkSession, KimiCliSession, KimiPrintSession, ChatWebSession } =
      await import("../src/session-factory.js");
    for (const Klass of [
      CodexExecSession,
      CopilotSdkSession,
      OpencodeSdkSession,
      KimiCliSession,
      KimiPrintSession,
      ChatWebSession,
    ]) {
      assert.equal(
        typeof Klass.prototype.runGoal,
        "undefined",
        `${Klass.name} should not implement runGoal in v1`,
      );
      // And the capability resolver must report goal=false for them.
      const { resolveSessionCapabilities } = await import("../src/shared.js");
      // We can't construct each one without dependencies; resolveSessionCapabilities
      // accepts a partial object exposing constructor/getCapabilities. Use a stub.
      const stub = Object.create(Klass.prototype);
      Object.defineProperty(stub, "constructor", { value: Klass });
      const caps = resolveSessionCapabilities(stub);
      assert.equal(caps.goal, false, `${Klass.name} should default to goal=false`);
    }
  });
});
