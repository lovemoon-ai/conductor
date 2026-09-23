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

function makeSession(sessionId, { sessionStream = true, onClose, clear = false, runClear } = {}) {
  const calls = { runTurn: [], close: 0, messageHandlers: 0, runClear: [] };
  let currentSessionId = sessionId;
  return {
    calls,
    getSnapshot: () => ({ capabilities: { goal: false, compact: true, clear } }),
    ...(clear
      ? {
          runClear: async (request, options) => {
            calls.runClear.push({ request, options });
            if (typeof runClear === "function") {
              return await runClear(request, options);
            }
            currentSessionId = `${sessionId}-cleared`;
            return { clear: { status: "cleared", sessionId: currentSessionId }, usage: null, metadata: {} };
          },
        }
      : {}),
    usesSessionFileReplyStream: () => sessionStream,
    setSessionMessageHandler: () => {
      calls.messageHandlers += 1;
    },
    ensureSessionInfo: async () => (currentSessionId ? { sessionId: currentSessionId } : null),
    getSessionInfo: () => (currentSessionId ? { sessionId: currentSessionId } : null),
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

function buildRunner({ sessionStream = true, onClose, clear = false, runClear } = {}) {
  const oldSession = makeSession("old-session", { sessionStream, onClose, clear, runClear });
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

  it("uses the backend's native clear and keeps the same session alive", async () => {
    const { runner, conductor, oldSession, freshSessions } = buildRunner({ clear: true });
    const progress = [];

    const result = await runner.dispatchBackendTurn("/clear", {
      replyTo: "msg-clear",
      onProgress: (payload) => progress.push(payload),
    });

    assert.equal(oldSession.calls.runClear.length, 1);
    assert.deepEqual(oldSession.calls.runClear[0].request, {});
    assert.equal(oldSession.calls.close, 0, "native clear must not close the session");
    assert.equal(freshSessions.length, 0, "native clear must not spawn a replacement session");
    assert.equal(runner.backendSession, oldSession);
    assert.equal(oldSession.calls.runTurn.length, 0);
    // The native clear moved to a new session id, so the task is rebound to it.
    assert.deepEqual(conductor.bindings.map((binding) => binding.session_id), ["old-session-cleared"]);
    assert.deepEqual(conductor.sent.map((entry) => entry.content), ["claude 上下文已清除。"]);
    assert.equal(conductor.sent[0].metadata.reply_to, "msg-clear");
    assert.equal(result.text, "claude 上下文已清除。");
    assert.equal(result.metadata.clear.status, "cleared");
    assert.deepEqual(progress.map((payload) => payload.phase), ["context_clear", "turn_completed"]);
  });

  it("never binds the task to a deferred placeholder id after a native clear", async () => {
    // chat-web drops back to a synthetic id until its next reply lands; binding
    // it would point the task at something that can never be resumed.
    const { runner, conductor, oldSession } = buildRunner({
      clear: true,
      runClear: async () => ({ clear: { status: "cleared" }, usage: null, metadata: {} }),
    });
    oldSession.ensureSessionInfo = async () => ({ sessionId: "chat-web-chatgpt-synthetic", sessionIdDeferred: true });
    oldSession.getSessionInfo = () => ({ sessionId: "chat-web-chatgpt-synthetic", sessionIdDeferred: true });

    await runner.dispatchBackendTurn("/clear", { replyTo: "msg-clear" });

    assert.deepEqual(conductor.bindings, []);
    assert.equal(runner.boundSessionId, "old-session");
    assert.deepEqual(conductor.sent.map((entry) => entry.content), ["claude 上下文已清除。"]);
  });

  it("reports a native noop when there was nothing to clear", async () => {
    const { runner, conductor } = buildRunner({
      clear: true,
      runClear: async () => ({ clear: { status: "noop" }, usage: null, metadata: {} }),
    });

    const result = await runner.dispatchBackendTurn("/clear", { replyTo: "msg-clear" });

    assert.deepEqual(conductor.sent.map((entry) => entry.content), ["claude 当前没有可清除的上下文。"]);
    assert.equal(result.metadata.clear.status, "noop");
  });

  it("reports the native clear's token usage like a turn", async () => {
    const reports = [];
    const { runner, conductor } = buildRunner({
      clear: true,
      runClear: async () => ({
        clear: { status: "cleared" },
        usage: { input_tokens: 12, output_tokens: 8 },
        metadata: {},
      }),
    });
    conductor.sendTurnUsage = async (_taskId, payload) => {
      reports.push(payload);
    };

    await runner.dispatchBackendTurn("/clear", { replyTo: "msg-usage" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(reports, [{ tokens: 20 }]);
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
