import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OpencodeSdkSession } from "../src/session-factory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FAKE_OPENCODE_SERVER = path.resolve(__dirname, "..", "fixtures", "fake-opencode-server.js");

class StubTransport extends EventEmitter {
  constructor() {
    super();
    this.bootCalls = 0;
    this.closeCalls = 0;
    this.pid = 4242;
  }

  async boot() {
    this.bootCalls += 1;
    return { url: "http://127.0.0.1:4096" };
  }

  async close() {
    this.closeCalls += 1;
  }
}

function createAsyncEventQueue() {
  const values = [];
  const waiters = [];
  let ended = false;

  return {
    push(value) {
      if (ended) {
        throw new Error("Event queue already ended");
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value, done: false });
        return;
      }
      values.push(value);
    },
    end() {
      if (ended) {
        return;
      }
      ended = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (values.length > 0) {
        return { value: values.shift(), done: false };
      }
      if (ended) {
        return { value: undefined, done: true };
      }
      return await new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

function createStubSdkHarness({ onPromptAsync } = {}) {
  const streamQueues = [];
  let promptCalls = 0;
  let subscribeCalls = 0;
  let abortCalls = 0;
  const sessionInfo = { id: "session-stub-opencode" };

  const client = {
    event: {
      async subscribe(_payload, options = {}) {
        const queue = createAsyncEventQueue();
        streamQueues.push(queue);
        subscribeCalls += 1;
        const signal = options?.signal;
        if (signal?.aborted) {
          queue.end();
        } else if (signal) {
          signal.addEventListener("abort", () => queue.end(), { once: true });
        }
        return { stream: queue };
      },
    },
    session: {
      async create() {
        return sessionInfo;
      },
      async get() {
        return sessionInfo;
      },
      async promptAsync(payload, options = {}) {
        promptCalls += 1;
        if (typeof onPromptAsync === "function") {
          await onPromptAsync({
            payload,
            options,
            promptCalls,
            getActiveQueue: () => streamQueues.at(-1),
          });
        }
        return {};
      },
      async abort() {
        abortCalls += 1;
        return { ok: true };
      },
    },
  };

  return {
    sdkModule: {
      createOpencodeClient() {
        return client;
      },
    },
    getAbortCalls() {
      return abortCalls;
    },
    getPromptCalls() {
      return promptCalls;
    },
    getQueue(index) {
      return streamQueues[index];
    },
    getSubscribeCalls() {
      return subscribeCalls;
    },
  };
}

function emitSuccessfulTurn(queue, { sessionId, text, suffix = "1" }) {
  queue.push({
    type: "session.status",
    properties: {
      sessionID: sessionId,
      status: { type: "busy" },
    },
  });
  queue.push({
    type: "message.updated",
    properties: {
      info: {
        id: `message-${suffix}`,
        sessionID: sessionId,
        role: "assistant",
      },
    },
  });
  queue.push({
    type: "message.part.updated",
    properties: {
      part: {
        id: `part-${suffix}`,
        sessionID: sessionId,
        messageID: `message-${suffix}`,
        type: "text",
        text,
      },
    },
  });
  queue.push({
    type: "session.idle",
    properties: {
      sessionID: sessionId,
    },
  });
}

async function waitForCondition(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe("opencode sdk session", () => {
  it("runs opencode turns through the local server and emits assistant messages", async () => {
    const messages = [];
    const statuses = [];
    const session = new OpencodeSdkSession("opencode", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_OPENCODE_SERVER}`,
      logger: { log: () => {} },
    });

    session.setSessionMessageHandler(async (payload) => {
      messages.push(payload);
    });
    session.setWorkingStatusHandler(async (payload) => {
      statuses.push(payload);
    });
    session.setSessionReplyTarget("reply-opencode-1");

    const sessionInfo = await session.ensureSessionInfo();
    assert.ok(String(sessionInfo?.sessionId || "").startsWith("session-fake-opencode-"));
    assert.equal(session.getSnapshot().provider, "opencode-sdk");

    const result = await session.runTurn("Reply with exactly OK");
    assert.equal(result.text, "OK from fake opencode\n");
    assert.deepEqual(
      messages.map((payload) => payload.text),
      ["OK from fake opencode\n"],
    );
    assert.ok(messages.every((payload) => payload.replyTo === "reply-opencode-1"));
    assert.ok(statuses.some((payload) => payload.phase === "reasoning"));
    assert.ok(statuses.some((payload) => payload.phase === "planning"));
    assert.ok(statuses.some((payload) => payload.phase === "command_execution"));
    assert.ok(statuses.some((payload) => payload.phase === "message_aggregation"));
    assert.ok(statuses.some((payload) => payload.phase === "turn_completed"));
    assert.ok(statuses.some((payload) => payload.reply_in_progress === false));
    assert.ok(statuses.every((payload) => payload.source === "opencode-sdk"));

    const usage = await session.getSessionUsageSummary();
    assert.equal(usage.sessionId, sessionInfo.sessionId);
    assert.equal(Number.isFinite(Number(usage.totalCostUsd)), true);

    await session.close();
  });

  it("emits auth_required when opencode reports provider auth failure", async () => {
    const authRequiredEvents = [];
    const statuses = [];
    const session = new OpencodeSdkSession("opencode", {
      cwd: process.cwd(),
      commandLine: `${process.execPath} ${FAKE_OPENCODE_SERVER}`,
      logger: { log: () => {} },
    });

    session.on("auth_required", (payload) => {
      authRequiredEvents.push(payload);
    });
    session.setWorkingStatusHandler(async (payload) => {
      statuses.push(payload);
    });

    await session.ensureSessionInfo();

    await assert.rejects(
      () => session.runTurn("trigger [auth-error]"),
      /Login required for provider/,
    );

    const lastStatus = statuses.at(-1);
    assert.equal(authRequiredEvents.length, 1);
    assert.equal(authRequiredEvents[0]?.reason, "login_required");
    assert.equal(lastStatus?.reply_in_progress, false);
    assert.equal(lastStatus?.status_done_line, "Login required for provider");

    await session.close();
  });

  it("enforces the hard deadline even when promptAsync hangs before submit completes", async () => {
    const transport = new StubTransport();
    const harness = createStubSdkHarness({
      async onPromptAsync() {
        return await new Promise(() => {});
      },
    });
    const session = new OpencodeSdkSession("opencode", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: harness.sdkModule,
      transport,
    });
    session.turnDeadlineMs = 50;

    await session.ensureSessionInfo();

    const startedAt = Date.now();
    const keepAlive = setInterval(() => {}, 1000);
    try {
      await assert.rejects(
        () => session.runTurn("deadline please"),
        (error) => error?.reason === "turn_timeout",
      );
      assert.ok(Date.now() - startedAt < 500);
      assert.ok(harness.getAbortCalls() >= 1);
    } finally {
      clearInterval(keepAlive);
      await session.close();
    }
  });

  it("aborts the remote turn when opencode asks for permission or user input", async () => {
    const scenarios = [
      {
        event: {
          type: "question.asked",
          properties: {
            sessionID: "session-stub-opencode",
            questions: [
              {
                header: "Confirm",
                question: "Proceed?",
              },
            ],
          },
        },
        expectedReason: "question_required",
      },
      {
        event: {
          type: "permission.asked",
          properties: {
            sessionID: "session-stub-opencode",
            permission: "write",
            patterns: ["**/*"],
          },
        },
        expectedReason: "permission_required",
      },
    ];

    for (const scenario of scenarios) {
      const transport = new StubTransport();
      const harness = createStubSdkHarness({
        async onPromptAsync({ promptCalls, getActiveQueue }) {
          const queue = getActiveQueue();
          queueMicrotask(() => {
            if (promptCalls === 1) {
              queue.push(scenario.event);
              return;
            }
            emitSuccessfulTurn(queue, {
              sessionId: "session-stub-opencode",
              text: `recovered-${scenario.expectedReason}`,
              suffix: String(promptCalls),
            });
          });
        },
      });
      const session = new OpencodeSdkSession("opencode", {
        cwd: process.cwd(),
        logger: { log: () => {} },
        sdkModule: harness.sdkModule,
        transport,
      });

      await session.ensureSessionInfo();

      await assert.rejects(
        () => session.runTurn(`trigger ${scenario.expectedReason}`),
        (error) => error?.reason === scenario.expectedReason,
      );
      assert.equal(harness.getAbortCalls(), 1);

      const recovered = await session.runTurn("recover");
      assert.equal(recovered.text, `recovered-${scenario.expectedReason}`);
      assert.equal(harness.getAbortCalls(), 1);

      await session.close();
      assert.equal(transport.closeCalls, 1);
    }
  });

  it("re-subscribes to the event stream after an idle disconnect", async () => {
    const transport = new StubTransport();
    const harness = createStubSdkHarness({
      async onPromptAsync({ promptCalls, getActiveQueue }) {
        const queue = getActiveQueue();
        queueMicrotask(() => {
          emitSuccessfulTurn(queue, {
            sessionId: "session-stub-opencode",
            text: `reply-${promptCalls}`,
            suffix: String(promptCalls),
          });
        });
      },
    });
    const session = new OpencodeSdkSession("opencode", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: harness.sdkModule,
      transport,
    });

    await session.ensureSessionInfo();
    const first = await session.runTurn("first");
    assert.equal(first.text, "reply-1");
    assert.equal(harness.getSubscribeCalls(), 1);

    harness.getQueue(0).end();
    await waitForCondition(() => session.eventStreamPromise === null);

    const second = await session.runTurn("second");
    assert.equal(second.text, "reply-2");
    assert.equal(harness.getSubscribeCalls(), 2);

    await session.close();
  });

  it("does not echo user messages back as assistant replies", async () => {
    const messages = [];
    const transport = new StubTransport();
    const harness = createStubSdkHarness({
      async onPromptAsync({ getActiveQueue }) {
        const queue = getActiveQueue();
        queueMicrotask(() => {
          queue.push({
            type: "message.updated",
            properties: {
              info: {
                id: "user-message-1",
                sessionID: "session-stub-opencode",
                role: "user",
              },
            },
          });
          queue.push({
            type: "message.part.updated",
            properties: {
              part: {
                id: "user-part-1",
                sessionID: "session-stub-opencode",
                messageID: "user-message-1",
                type: "text",
                text: "1+1=",
              },
            },
          });
          queue.push({
            type: "message.updated",
            properties: {
              info: {
                id: "assistant-message-1",
                sessionID: "session-stub-opencode",
                role: "assistant",
              },
            },
          });
          queue.push({
            type: "message.part.updated",
            properties: {
              part: {
                id: "assistant-part-1",
                sessionID: "session-stub-opencode",
                messageID: "assistant-message-1",
                type: "text",
                text: "2",
              },
            },
          });
          queue.push({
            type: "session.idle",
            properties: {
              sessionID: "session-stub-opencode",
            },
          });
        });
      },
    });
    const session = new OpencodeSdkSession("opencode", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: harness.sdkModule,
      transport,
    });

    session.setSessionMessageHandler(async (payload) => {
      messages.push(payload.text);
    });

    await session.ensureSessionInfo();
    const result = await session.runTurn("1+1=");
    assert.equal(result.text, "2");
    assert.deepEqual(messages, ["2"]);

    await session.close();
  });
});
