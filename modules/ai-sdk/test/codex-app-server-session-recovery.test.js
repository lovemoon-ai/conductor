import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerSession } from "../src/providers/codex-app-server-session.js";

// A minimal in-memory transport: it never spawns a real codex process. Turn
// completion is driven by the test via `session.handleNotification`.
function makeFakeTransport() {
  const calls = { threadStart: 0, turnStart: 0 };
  return {
    pid: 4321,
    calls,
    async boot() {},
    async request(method) {
      if (method === "thread/start") {
        calls.threadStart += 1;
        return { thread: { id: `thread-${calls.threadStart}`, path: "" } };
      }
      if (method === "turn/start") {
        calls.turnStart += 1;
        return { turn: { items: [] } };
      }
      return {};
    },
    async close() {},
    on() {},
    off() {},
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitForNewTurn(session, previous) {
  for (let i = 0; i < 500; i += 1) {
    if (session.currentTurn && session.currentTurn !== previous) {
      return session.currentTurn;
    }
    await tick();
  }
  throw new Error("timed out waiting for a new currentTurn");
}

function makeSession() {
  const session = new CodexAppServerSession("codex", {
    cwd: process.cwd(),
    logger: { log: () => {} },
  });
  session.transport = makeFakeTransport();
  return session;
}

const overflow = (message) => ({ turn: { status: "failed", error: { message } } });

describe("codex app-server session - oversized-thread recovery", () => {
  it("rolls onto a fresh thread and retries once on context overflow", async () => {
    const session = makeSession();
    const recovered = [];
    session.on("thread_recovered", (event) => recovered.push(event));
    try {
      const turnPromise = session.runTurn("hello world");
      const firstTurn = await waitForNewTurn(session, null);

      await session.handleNotification(
        "turn/completed",
        overflow("This model's maximum context length is 128000 tokens"),
      );

      // Recovery boots a fresh thread and starts a new turn.
      await waitForNewTurn(session, firstTurn);
      await session.handleNotification("turn/completed", { turn: { status: "completed" } });

      const result = await turnPromise;
      assert.equal(session.transport.calls.threadStart, 2, "should start a fresh thread");
      assert.equal(session.transport.calls.turnStart, 2, "should retry the turn once");
      assert.equal(result.metadata.threadId, "thread-2");
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].reason, "context_overflow");
    } finally {
      await session.close();
    }
  });

  it("does not recover from an ordinary (non-overflow) turn failure", async () => {
    const session = makeSession();
    try {
      const outcome = session.runTurn("hi").then(
        () => "ok",
        (error) => error,
      );
      await waitForNewTurn(session, null);
      await session.handleNotification("turn/completed", overflow("tool exploded"));

      const result = await outcome;
      assert.ok(result instanceof Error, "ordinary failure should reject");
      assert.equal(session.transport.calls.threadStart, 1);
      assert.equal(session.transport.calls.turnStart, 1);
    } finally {
      await session.close();
    }
  });

  it("retries at most once, then fails when the fresh thread also overflows", async () => {
    const session = makeSession();
    try {
      const outcome = session.runTurn("hi").then(
        () => "ok",
        (error) => error,
      );
      const firstTurn = await waitForNewTurn(session, null);
      await session.handleNotification("turn/completed", overflow("maximum context length exceeded"));

      await waitForNewTurn(session, firstTurn);
      await session.handleNotification("turn/completed", overflow("maximum context length exceeded"));

      const result = await outcome;
      assert.ok(result instanceof Error, "second overflow should reject");
      assert.equal(session.transport.calls.threadStart, 2, "only one fresh thread");
      assert.equal(session.transport.calls.turnStart, 2, "only one retry");
    } finally {
      await session.close();
    }
  });
});
