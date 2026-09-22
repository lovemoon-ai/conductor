import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BridgeRunner, isClearCommand } from "../bin/conductor-fire.js";

let uniqueTaskCounter = 0;
function uniqueTaskId() {
  uniqueTaskCounter += 1;
  return `task-clear-${process.pid}-${Date.now()}-${uniqueTaskCounter}`;
}

function buildConductorStub() {
  const sent = [];
  const bindings = [];
  return {
    sent,
    bindings,
    sendMessage: async (taskId, content, metadata) => {
      sent.push({ taskId, content, metadata });
      return {};
    },
    bindTaskSession: async (taskId, payload) => {
      bindings.push({ taskId, ...payload });
      return {};
    },
    sendRuntimeStatus: async () => ({}),
    ackMessages: async () => ({}),
    receiveMessages: async () => ({ messages: [] }),
  };
}

function makeSession(sessionId, { sessionStream = true, onClose } = {}) {
  const calls = { runTurn: [], close: 0, messageHandlers: 0 };
  return {
    calls,
    getSnapshot: () => ({ capabilities: { goal: false, compact: true } }),
    usesSessionFileReplyStream: () => sessionStream,
    setSessionMessageHandler: () => {
      calls.messageHandlers += 1;
    },
    ensureSessionInfo: async () => (sessionId ? { sessionId } : null),
    getSessionInfo: () => (sessionId ? { sessionId } : null),
    close: async () => {
      calls.close += 1;
      await onClose?.();
    },
    runTurn: async (content) => {
      calls.runTurn.push(content);
      return { text: `${sessionId}-reply` };
    },
  };
}

function buildRunner({ sessionStream = true, onClose } = {}) {
  const oldSession = makeSession("old-session", { sessionStream, onClose });
  const freshSessions = [];
  const conductor = buildConductorStub();
  const runner = new BridgeRunner({
    backendSession: oldSession,
    conductor,
    taskId: uniqueTaskId(),
    pollIntervalMs: 500,
    initialPrompt: "",
    includeInitialImages: false,
    cliArgs: [],
    backendName: "claude",
    resumeSessionId: "old-session",
    createFreshBackendSession: () => {
      const session = makeSession(`new-session-${freshSessions.length + 1}`, { sessionStream });
      freshSessions.push(session);
      return session;
    },
  });
  runner.boundSessionId = "old-session";
  return { runner, conductor, oldSession, freshSessions };
}

describe("isClearCommand", () => {
  it("matches only a bare /clear (case-insensitive, surrounding whitespace allowed)", () => {
    assert.equal(isClearCommand("/clear"), true);
    assert.equal(isClearCommand("\n  /CLEAR  \n"), true);
  });

  it("does not match anything else", () => {
    assert.equal(isClearCommand(undefined), false);
    assert.equal(isClearCommand(""), false);
    assert.equal(isClearCommand("/clear the build cache"), false);
    assert.equal(isClearCommand("/clearance"), false);
    assert.equal(isClearCommand("please /clear"), false);
    assert.equal(isClearCommand("/compact"), false);
  });
});

describe("BridgeRunner.dispatchBackendTurn /clear", () => {
  it("swaps in a fresh backend session, rebinds the task and posts one confirmation", async () => {
    const { runner, conductor, oldSession, freshSessions } = buildRunner();
    const progress = [];

    const result = await runner.dispatchBackendTurn("/clear", {
      replyTo: "msg-clear",
      onProgress: (payload) => progress.push(payload),
    });

    assert.equal(oldSession.calls.close, 1);
    assert.equal(oldSession.calls.runTurn.length, 0);
    assert.equal(freshSessions.length, 1);
    const [fresh] = freshSessions;
    assert.equal(runner.backendSession, fresh);
    assert.equal(fresh.calls.runTurn.length, 0);
    assert.equal(fresh.calls.messageHandlers, 1, "session stream handlers re-attached to the new session");
    assert.deepEqual(conductor.bindings.map((binding) => binding.session_id), ["new-session-1"]);
    assert.deepEqual(conductor.sent.map((entry) => entry.content), [
      "claude session started: new-session-1 (model=claude)",
      "claude 上下文已清除，已开始新会话。",
    ]);
    assert.equal(conductor.sent[1].metadata.reply_to, "msg-clear");
    assert.equal(result.text, "claude 上下文已清除，已开始新会话。");
    assert.deepEqual(progress.map((payload) => payload.phase), ["context_clear", "turn_completed"]);
    assert.equal(progress.at(-1).reply_in_progress, false);

    const next = await runner.dispatchBackendTurn("hello again", {});
    assert.equal(next.text, "new-session-1-reply");
    assert.deepEqual(fresh.calls.runTurn, ["hello again"]);
    assert.equal(oldSession.calls.runTurn.length, 0);
  });

  it("does not rebind the old resume id when the fresh session has no id yet", async () => {
    const { runner, conductor } = buildRunner();
    runner.createFreshBackendSession = () => makeSession(null);

    await runner.dispatchBackendTurn("/clear", { replyTo: "msg-clear" });

    assert.equal(runner.resumeSessionId, "");
    assert.deepEqual(conductor.bindings, []);
    assert.equal(conductor.sent[0].content, "claude session started (model=claude)");
  });

  it("leaves sending the confirmation to the caller when the backend does not stream replies", async () => {
    const { runner, conductor } = buildRunner({ sessionStream: false });

    const result = await runner.dispatchBackendTurn("/clear", { replyTo: "msg-clear" });

    assert.deepEqual(conductor.sent.map((entry) => entry.content), ["claude session started: new-session-1 (model=claude)"]);
    assert.equal(result.text, "claude 上下文已清除，已开始新会话。");
  });

  it("does not start a new session when the task stops while clearing", async () => {
    let runner;
    const built = buildRunner({
      onClose: () => {
        runner.stopped = true;
      },
    });
    runner = built.runner;

    await assert.rejects(runner.dispatchBackendTurn("/clear", { replyTo: "msg-clear" }), (error) => {
      assert.equal(error.reason, "session_closed");
      return true;
    });
    assert.equal(built.freshSessions.length, 0);
    assert.equal(built.conductor.sent.length, 0);
  });

  it("announces the fresh session under the fresh-session bootstrap lock", async () => {
    const { runner, conductor } = buildRunner();
    const order = [];
    runner.withFreshSessionBootstrap = async (fn) => {
      order.push("lock-acquired");
      const result = await fn();
      order.push("lock-released");
      return result;
    };

    await runner.dispatchBackendTurn("/clear", { replyTo: "msg-clear" });

    assert.deepEqual(order, ["lock-acquired", "lock-released"]);
    assert.deepEqual(conductor.bindings.map((binding) => binding.session_id), ["new-session-1"]);
  });

  it("routes the rest of the same message batch to the fresh session", async () => {
    const { runner, conductor, oldSession, freshSessions } = buildRunner({ sessionStream: false });
    const acked = [];
    conductor.receiveMessages = async () => ({
      messages: [
        { message_id: "m1", role: "user", content: "/clear" },
        { message_id: "m2", role: "user", content: "start over" },
      ],
      next_ack_token: "ack-1",
    });
    conductor.ackMessages = async (_taskId, token) => {
      acked.push(token);
    };

    await runner.processIncomingBatch();

    assert.equal(oldSession.calls.runTurn.length, 0);
    assert.deepEqual(freshSessions[0].calls.runTurn, ["start over"]);
    assert.deepEqual(
      conductor.sent.filter((entry) => entry.metadata?.reply_to).map((entry) => [entry.metadata.reply_to, entry.content]),
      [
        ["m1", "claude 上下文已清除，已开始新会话。"],
        ["m2", "new-session-1-reply"],
      ],
    );
    assert.deepEqual(acked, ["ack-1"]);
  });

  it("treats /clear with attachments as a normal message", async () => {
    const { runner, oldSession, freshSessions } = buildRunner();

    await runner.dispatchBackendTurn("/clear", {
      contextFiles: [{ path: "/tmp/notes.txt", name: "notes.txt" }],
    });

    assert.deepEqual(oldSession.calls.runTurn, ["/clear"]);
    assert.equal(oldSession.calls.close, 0);
    assert.equal(freshSessions.length, 0);
  });
});
