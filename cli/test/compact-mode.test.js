import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BridgeRunner,
  formatCompactReply,
  parseCompactDirectiveFromMessage,
} from "../bin/conductor-fire.js";

let uniqueTaskCounter = 0;
function uniqueTaskId() {
  uniqueTaskCounter += 1;
  return `task-compact-${process.pid}-${Date.now()}-${uniqueTaskCounter}`;
}

function buildConductorStub() {
  const sent = [];
  return {
    sent,
    sendMessage: async (taskId, content, metadata) => {
      sent.push({ taskId, content, metadata });
      return {};
    },
    sendRuntimeStatus: async () => ({}),
    ackMessages: async () => ({}),
    receiveMessages: async () => ({ messages: [] }),
  };
}

function makeSession({ compact = true, sessionStream = true, runCompact, runTurn } = {}) {
  const calls = { runCompact: [], runTurn: [] };
  const session = {
    calls,
    getSnapshot: () => ({ capabilities: { goal: false, compact } }),
    usesSessionFileReplyStream: () => sessionStream,
    runCompact: async (request, options) => {
      calls.runCompact.push({ request, options });
      if (typeof runCompact === "function") {
        return await runCompact(request, options);
      }
      return {
        compact: { status: "compacted", instructionsApplied: true, preTokens: 52000, postTokens: 3100 },
        usage: null,
        metadata: { source: "fake" },
      };
    },
    runTurn: async (content, options) => {
      calls.runTurn.push({ content, options });
      if (typeof runTurn === "function") {
        return await runTurn(content, options);
      }
      return { text: "turn-reply" };
    },
  };
  return session;
}

function buildRunner(backendSession, conductor = buildConductorStub()) {
  const runner = new BridgeRunner({
    backendSession,
    conductor,
    taskId: uniqueTaskId(),
    pollIntervalMs: 500,
    initialPrompt: "",
    includeInitialImages: false,
    cliArgs: [],
    backendName: "claude",
  });
  return { runner, conductor };
}

describe("parseCompactDirectiveFromMessage", () => {
  it("returns null without a leading /compact line", () => {
    assert.equal(parseCompactDirectiveFromMessage(undefined), null);
    assert.equal(parseCompactDirectiveFromMessage(""), null);
    assert.equal(parseCompactDirectiveFromMessage("please /compact"), null);
    assert.equal(parseCompactDirectiveFromMessage("hi\n/compact"), null);
    assert.equal(parseCompactDirectiveFromMessage("/compaction"), null);
    assert.equal(parseCompactDirectiveFromMessage("/goal ship"), null);
  });

  it("matches a bare /compact (case-insensitive, leading blank lines allowed)", () => {
    assert.deepEqual(parseCompactDirectiveFromMessage("/compact"), { instructions: "" });
    assert.deepEqual(parseCompactDirectiveFromMessage("\n  /COMPACT  \n"), { instructions: "" });
  });

  it("collects inline and following lines as focus instructions", () => {
    assert.deepEqual(parseCompactDirectiveFromMessage("/compact keep the API decisions"), {
      instructions: "keep the API decisions",
    });
    assert.deepEqual(parseCompactDirectiveFromMessage("/compact keep decisions\nand the todo list"), {
      instructions: "keep decisions\n\nand the todo list",
    });
  });
});

describe("formatCompactReply", () => {
  it("reports token counts when the backend provides them", () => {
    assert.equal(
      formatCompactReply("claude", { status: "compacted", instructionsApplied: false, preTokens: 52000, postTokens: 3100 }),
      "claude 上下文已压缩（约 52,000 → 3,100 tokens）。",
    );
    assert.equal(
      formatCompactReply("copilot", { status: "compacted", instructionsApplied: true, tokensRemoved: 4200 }, "focus"),
      "copilot 上下文已压缩（释放约 4,200 tokens）。",
    );
  });

  it("notes ignored instructions and empty contexts", () => {
    assert.equal(
      formatCompactReply("codex", { status: "compacted", instructionsApplied: false }, "focus"),
      "codex 上下文已压缩。\ncodex 不支持压缩附加说明，已忽略。",
    );
    assert.equal(formatCompactReply("kimi", { status: "noop", instructionsApplied: false }), "kimi 当前没有可压缩的上下文。");
  });
});

describe("BridgeRunner.dispatchBackendTurn /compact routing", () => {
  it("runs runCompact instead of a model turn and posts one confirmation to the reply target", async () => {
    const backendSession = makeSession();
    const { runner, conductor } = buildRunner(backendSession);
    const progress = [];

    const result = await runner.dispatchBackendTurn("/compact keep the API decisions", {
      replyTo: "msg-1",
      onProgress: (payload) => progress.push(payload),
    });

    assert.equal(backendSession.calls.runTurn.length, 0);
    assert.equal(backendSession.calls.runCompact.length, 1);
    assert.deepEqual(backendSession.calls.runCompact[0].request, { instructions: "keep the API decisions" });
    assert.equal(typeof backendSession.calls.runCompact[0].options.onProgress, "function");
    assert.equal(progress[0].phase, "context_compaction");
    assert.equal(conductor.sent.length, 1);
    assert.equal(conductor.sent[0].content, "claude 上下文已压缩（约 52,000 → 3,100 tokens）。");
    assert.equal(conductor.sent[0].metadata.reply_to, "msg-1");
    assert.equal(result.text, conductor.sent[0].content);
    assert.equal(result.metadata.compact.status, "compacted");
  });

  it("settles the runtime status even when the provider returns a silent noop", async () => {
    const backendSession = makeSession({
      runCompact: async () => ({ compact: { status: "noop", instructionsApplied: false }, usage: null, metadata: {} }),
    });
    const { runner, conductor } = buildRunner(backendSession);
    const progress = [];

    await runner.dispatchBackendTurn("/compact", {
      replyTo: "msg-noop",
      onProgress: (payload) => progress.push(payload),
    });

    assert.deepEqual(progress.map((payload) => payload.phase), ["context_compaction", "turn_completed"]);
    assert.equal(progress.at(-1).reply_in_progress, false);
    assert.deepEqual(conductor.sent.map((entry) => entry.content), ["claude 当前没有可压缩的上下文。"]);
  });

  it("does not post the confirmation after the task was stopped mid-compaction", async () => {
    let runner;
    const backendSession = makeSession({
      runCompact: async () => {
        runner.stopped = true;
        return { compact: { status: "compacted", instructionsApplied: false }, usage: null, metadata: {} };
      },
    });
    const built = buildRunner(backendSession);
    runner = built.runner;

    await runner.dispatchBackendTurn("/compact", { replyTo: "msg-stop" });

    assert.equal(built.conductor.sent.length, 0);
  });

  it("leaves sending to the caller when the backend does not stream replies", async () => {
    const backendSession = makeSession({ sessionStream: false });
    const { runner, conductor } = buildRunner(backendSession);

    const result = await runner.dispatchBackendTurn("/compact", { replyTo: "msg-2" });

    assert.equal(conductor.sent.length, 0);
    assert.equal(result.text, "claude 上下文已压缩（约 52,000 → 3,100 tokens）。");
  });

  it("answers with a notice and never reaches the model when the backend cannot compact", async () => {
    const backendSession = makeSession({ compact: false });
    const { runner, conductor } = buildRunner(backendSession);
    const progress = [];

    await runner.dispatchBackendTurn("/compact", {
      replyTo: "msg-3",
      onProgress: (payload) => progress.push(payload),
    });

    assert.equal(backendSession.calls.runCompact.length, 0);
    assert.equal(backendSession.calls.runTurn.length, 0);
    assert.deepEqual(
      conductor.sent.map((entry) => entry.content),
      ["claude 不支持 /compact，未执行压缩。"],
    );
    assert.equal(progress.at(-1).reply_in_progress, false);
  });

  it("treats /compact with attachments as a normal message", async () => {
    const backendSession = makeSession();
    const { runner } = buildRunner(backendSession);

    await runner.dispatchBackendTurn("/compact", { contextFiles: [{ path: "/tmp/a.txt" }] });

    assert.equal(backendSession.calls.runCompact.length, 0);
    assert.equal(backendSession.calls.runTurn.length, 1);
  });

  it("propagates compaction failures to the turn error path", async () => {
    const backendSession = makeSession({
      runCompact: async () => {
        const error = new Error("compaction failed: rate limited");
        error.reason = "compact_failed";
        throw error;
      },
    });
    const { runner, conductor } = buildRunner(backendSession);

    await assert.rejects(runner.dispatchBackendTurn("/compact", { replyTo: "msg-4" }), /rate limited/);
    assert.equal(conductor.sent.length, 0);
  });
});
