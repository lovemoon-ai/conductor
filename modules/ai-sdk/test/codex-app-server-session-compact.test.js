import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerSession } from "../src/providers/codex-app-server-session.js";

// In-memory transport; turn completion is driven via `session.handleNotification`.
function makeFakeTransport() {
  const calls = [];
  let threads = 0;
  return {
    pid: 4321,
    calls,
    async boot() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") {
        threads += 1;
        return { thread: { id: `thread-${threads}`, path: "" } };
      }
      if (method === "thread/resume") {
        return { thread: { id: params.threadId, path: "" } };
      }
      if (method === "turn/start") {
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

async function waitForTurn(session) {
  for (let i = 0; i < 500; i += 1) {
    if (session.currentTurn && session.transport.calls.some((call) => call.method === "thread/compact/start")) {
      return session.currentTurn;
    }
    await tick();
  }
  throw new Error("timed out waiting for the compaction turn");
}

function makeSession(options = {}) {
  const session = new CodexAppServerSession("codex", {
    cwd: process.cwd(),
    logger: { log: () => {} },
    ...options,
  });
  session.transport = makeFakeTransport();
  return session;
}

describe("codex app-server session - runCompact", () => {
  it("advertises compact capability", () => {
    assert.equal(makeSession().getSnapshot().capabilities.compact, true);
  });

  it("starts thread/compact/start on the resumed thread and resolves on turn/completed without emitting a reply", async () => {
    const session = makeSession({ resumeSessionId: "thread-resumed" });
    const emitted = [];
    session.setSessionMessageHandler((payload) => emitted.push(payload));
    try {
      const compactPromise = session.runCompact({ instructions: "focus on tests" });
      await waitForTurn(session);
      await session.handleNotification("turn/started", { turn: { id: "turn-c" } });
      await session.handleNotification("item/started", { turnId: "turn-c", item: { type: "contextCompaction", id: "c1" } });
      await session.handleNotification("item/agentMessage/delta", { turnId: "turn-c", itemId: "m1", delta: "summary" });
      await session.handleNotification("item/completed", { turnId: "turn-c", item: { type: "agentMessage", id: "m1" } });
      await session.handleNotification("turn/completed", { turn: { id: "turn-c", status: "completed" } });

      const result = await compactPromise;
      assert.deepEqual(result.compact, { status: "compacted", instructionsApplied: false });
      assert.equal(result.metadata.threadId, "thread-resumed");
      const compactCall = session.transport.calls.find((call) => call.method === "thread/compact/start");
      assert.deepEqual(compactCall.params, { threadId: "thread-resumed" });
      assert.equal(emitted.length, 0);
      assert.equal(session.currentTurn, null);
    } finally {
      await session.close();
    }
  });

  it("is a noop on a fresh thread with no conversation", async () => {
    const session = makeSession();
    try {
      const result = await session.runCompact({});
      assert.deepEqual(result.compact, { status: "noop", instructionsApplied: false });
      assert.deepEqual(session.transport.calls, []);
    } finally {
      await session.close();
    }
  });

  it("rejects when the compaction turn fails", async () => {
    const session = makeSession({ resumeSessionId: "thread-resumed" });
    try {
      const compactPromise = session.runCompact({});
      await waitForTurn(session);
      await session.handleNotification("turn/completed", { turn: { status: "failed", error: { message: "boom" } } });
      await assert.rejects(compactPromise, (error) => error.reason === "turn_failed");
      assert.equal(session.currentTurn, null);
    } finally {
      await session.close();
    }
  });
});
