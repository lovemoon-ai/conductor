#!/usr/bin/env node

import readline from "node:readline";

const ENABLE_GOALS_VIA_ARGS =
  (process.argv.includes("--enable") && process.argv.includes("goals")) ||
  process.argv.some(
    (arg) =>
      typeof arg === "string" &&
      arg.startsWith("--enable=") &&
      arg
        .slice("--enable=".length)
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .includes("goals"),
  );
const FAIL_GOAL_SET_WHEN_DISABLED = !ENABLE_GOALS_VIA_ARGS;
const FAIL_FAST_TERMINAL_STATUS = process.env.FAKE_CODEX_GOAL_FAIL_FAST_STATUS || "";
const CLEAR_INSTEAD_OF_COMPLETE = process.env.FAKE_CODEX_GOAL_CLEAR === "1";
// Race control flags. When set, the fake server reorders events so the
// session must tolerate the race (otherwise text/notifications are dropped).
const GOAL_UPDATE_AFTER_TURN_COMPLETED = process.env.FAKE_CODEX_GOAL_UPDATE_AFTER_TURN === "1";
const SECOND_TURN_DELTA_BEFORE_STARTED = process.env.FAKE_CODEX_GOAL_DELTA_BEFORE_START === "1";
const TURN_COUNT = Math.max(
  1,
  Number.parseInt(process.env.FAKE_CODEX_GOAL_TURN_COUNT || "1", 10) || 1,
);
// Return null (instead of {goal:null}) when thread/goal/get is invoked to
// simulate a transport hiccup. Exercises the I5 fix in getGoal().
const RETURN_NULL_FROM_GOAL_GET = process.env.FAKE_CODEX_GOAL_GET_NULL === "1";
// When set, the fake server never emits a terminal `thread/goal/updated` or
// `thread/goal/cleared` after `thread/goal/set` returns. Used to exercise
// "clearGoal called mid-runGoal" and "transport exits mid-runGoal" scenarios
// where the goal-run would otherwise hang waiting for a terminal status.
const HOLD_GOAL_OPEN = process.env.FAKE_CODEX_GOAL_HOLD_OPEN === "1";
// When set, the fake server kills its own process immediately after acking
// `thread/goal/set` (no notifications, no responses). Simulates the codex
// app-server dying mid-goal.
const EXIT_AFTER_GOAL_SET = process.env.FAKE_CODEX_GOAL_EXIT_AFTER_SET === "1";

let nextThreadId = 1;
let nextTurnId = 1;
let nextGoalId = 1;
let currentGoal = null;
let currentThreadId = "";

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function errorResponse(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function notification(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function startThread(id, params = {}) {
  const threadId = params.threadId || `thread-goal-${nextThreadId++}`;
  currentThreadId = threadId;
  response(id, {
    thread: {
      id: threadId,
      path: `/tmp/${threadId}.jsonl`,
      cwd: params.cwd || process.cwd(),
    },
    model: "gpt-fake-codex",
    modelProvider: "fake-provider",
  });
}

function scheduleTurn({ threadId, turnIndex, totalTurns, baseDelayMs, sendOrder, after }) {
  const turnId = `turn-${nextTurnId++}`;
  const messageId = `msg-${turnId}-1`;
  const text = `working on goal turn ${turnIndex}`;

  // `sendOrder` describes when each event fires relative to `baseDelayMs`.
  // Defaults to the natural order. To exercise the C2 race, set
  // `deltaFirst: true` to fire the delta before `turn/started`.
  const order = sendOrder || { deltaFirst: false };

  const fireTurnStarted = () =>
    notification("turn/started", {
      threadId,
      turn: { id: turnId, status: "inProgress" },
    });
  const fireItemStarted = () =>
    notification("item/started", {
      threadId,
      turnId,
      item: { type: "message", role: "assistant", id: messageId },
    });
  const fireDelta = () =>
    notification("item/agentMessage/delta", {
      threadId,
      turnId,
      itemId: messageId,
      delta: text,
    });
  const fireItemCompleted = () =>
    notification("item/completed", {
      threadId,
      turnId,
      item: { type: "message", role: "assistant", id: messageId },
    });
  const fireTurnCompleted = () =>
    notification("turn/completed", {
      threadId,
      turn: { id: turnId, status: "completed", error: null },
    });

  if (order.deltaFirst) {
    // Race the delta into the wire BEFORE `turn/started`. The session must
    // queue it and replay when `turn/started` arrives.
    setTimeout(fireDelta, baseDelayMs + 1);
    setTimeout(fireTurnStarted, baseDelayMs + 5);
    setTimeout(fireItemStarted, baseDelayMs + 10);
    setTimeout(fireItemCompleted, baseDelayMs + 15);
    setTimeout(fireTurnCompleted, baseDelayMs + 20);
  } else {
    setTimeout(fireTurnStarted, baseDelayMs);
    setTimeout(fireItemStarted, baseDelayMs + 5);
    setTimeout(fireDelta, baseDelayMs + 10);
    setTimeout(fireItemCompleted, baseDelayMs + 15);
    setTimeout(fireTurnCompleted, baseDelayMs + 20);
  }

  if (typeof after === "function") {
    setTimeout(() => after({ turnId, baseDelayMs }), baseDelayMs + 25);
  }
}

function setGoal(id, params = {}) {
  if (FAIL_GOAL_SET_WHEN_DISABLED) {
    errorResponse(id, -32603, "goals feature is disabled");
    return;
  }
  const goalId = `goal-${nextGoalId++}`;
  currentGoal = {
    id: goalId,
    threadId: params.threadId || currentThreadId,
    objective: params.objective,
    status: params.status || "active",
    tokenBudget: params.tokenBudget ?? null,
  };
  response(id, { goal: { ...currentGoal } });

  if (EXIT_AFTER_GOAL_SET) {
    // Simulate the codex app-server crashing right after acking the goal.
    // No notifications, no further responses — the session should observe
    // the process exit and reject the goal-run with reason="transport_exited".
    setTimeout(() => {
      // Use code 1 to mimic an abnormal exit.
      process.exit(1);
    }, 5);
    return;
  }

  if (HOLD_GOAL_OPEN) {
    // Never emit a terminal goal status. The test is expected to either
    // call clearGoal() externally or tear the session down.
    return;
  }

  // Schedule TURN_COUNT turns back-to-back. After the last turn completes,
  // optionally delay the terminal `thread/goal/updated` (or `cleared`) to
  // exercise the C1 race where the goal update arrives AFTER `turn/completed`.
  const scheduleNextTurn = (turnIndex) => {
    if (turnIndex > TURN_COUNT) {
      // Final terminal goal event.
      const terminalDelayMs = GOAL_UPDATE_AFTER_TURN_COMPLETED ? 20 : 0;
      setTimeout(() => {
        const terminalStatus = FAIL_FAST_TERMINAL_STATUS || "complete";
        const updated = { ...currentGoal, status: terminalStatus };
        currentGoal = updated;
        if (CLEAR_INSTEAD_OF_COMPLETE) {
          notification("thread/goal/cleared", {
            threadId: updated.threadId,
            goal: updated,
          });
          currentGoal = null;
        } else {
          notification("thread/goal/updated", {
            threadId: updated.threadId,
            goal: updated,
          });
        }
      }, terminalDelayMs);
      return;
    }
    const baseDelayMs = 5 + (turnIndex - 1) * 30;
    const sendOrder = {
      deltaFirst: SECOND_TURN_DELTA_BEFORE_STARTED && turnIndex >= 2,
    };
    scheduleTurn({
      threadId: currentGoal.threadId,
      turnIndex,
      totalTurns: TURN_COUNT,
      baseDelayMs,
      sendOrder,
      after: () => scheduleNextTurn(turnIndex + 1),
    });
  };

  setTimeout(() => scheduleNextTurn(1), 5);
}

function getGoal(id) {
  if (RETURN_NULL_FROM_GOAL_GET) {
    response(id, null);
    return;
  }
  if (!currentGoal) {
    response(id, { goal: null });
    return;
  }
  response(id, { goal: { ...currentGoal } });
}

function clearGoal(id) {
  const had = Boolean(currentGoal);
  currentGoal = null;
  response(id, { cleared: had });
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const normalized = String(line || "").trim();
  if (!normalized) {
    return;
  }
  const message = JSON.parse(normalized);
  if (message.method === "initialize") {
    response(message.id, { userAgent: "fake-codex-app-server-goals/1.0.0" });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    startThread(message.id, message.params);
    return;
  }
  if (message.method === "thread/goal/set") {
    setGoal(message.id, message.params);
    return;
  }
  if (message.method === "thread/goal/get") {
    getGoal(message.id);
    return;
  }
  if (message.method === "thread/goal/clear") {
    clearGoal(message.id);
    return;
  }
  if (message.method === "turn/start") {
    response(message.id, { turn: { id: `turn-${nextTurnId++}`, status: "started" } });
    return;
  }
  response(message.id, { ok: true });
});
