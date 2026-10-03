import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ClaudeAgentSdkSession } from "../src/session-factory.js";

/**
 * A scripted claude process: it reads user messages from the prompt stream the
 * session hands to `query()` and emits whatever the test pushes, like the real
 * CLI does in streaming-input mode.
 */
function createFakeClaude() {
  const fake = {
    queries: [],
    get current() {
      return fake.queries.at(-1);
    },
    // runTurn awaits a few steps before it spawns or writes to the process.
    async nextPrompt() {
      while (!fake.current || fake.current.ended) {
        await tick();
      }
      return fake.current.nextPrompt();
    },
    sdkModule: {
      query: ({ prompt, options }) => {
        const outbox = [];
        let waiter = null;
        let ended = false;
        const prompts = [];
        const promptWaiters = [];
        const state = {
          options,
          prompts,
          inputClosed: false,
          closed: 0,
          interrupts: 0,
          emit(message) {
            if (waiter) {
              const resolve = waiter;
              waiter = null;
              resolve({ value: message, done: false });
            } else {
              outbox.push(message);
            }
          },
          end() {
            ended = true;
            state.ended = true;
            if (waiter) {
              const resolve = waiter;
              waiter = null;
              resolve({ value: undefined, done: true });
            }
          },
          async nextPrompt() {
            if (prompts.length > state.consumed) {
              return prompts[state.consumed++];
            }
            await new Promise((resolve) => promptWaiters.push(resolve));
            return prompts[state.consumed++];
          },
          consumed: 0,
        };
        void (async () => {
          for await (const message of prompt) {
            prompts.push(message);
            promptWaiters.splice(0).forEach((resolve) => resolve());
          }
          state.inputClosed = true;
        })();
        fake.queries.push(state);
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                if (outbox.length) {
                  return Promise.resolve({ value: outbox.shift(), done: false });
                }
                if (ended) {
                  return Promise.resolve({ value: undefined, done: true });
                }
                return new Promise((resolve) => {
                  waiter = resolve;
                });
              },
              return: () => Promise.resolve({ value: undefined, done: true }),
            };
          },
          interrupt: async () => {
            state.interrupts += 1;
          },
          close: () => {
            state.closed += 1;
            state.end();
          },
        };
      },
    },
  };
  return fake;
}

const usage = (inputTokens, outputTokens) => ({
  opus: { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
});

const result = (text, { uuid, modelUsage, subtype = "success" } = {}) => ({
  type: "result",
  subtype,
  session_id: "claude-live-1",
  result: text,
  ...(uuid ? { user_message_uuid: uuid, user_message_uuids: [uuid] } : {}),
  ...(modelUsage ? { modelUsage } : {}),
});

const assistant = (text, extra = {}) => ({
  type: "assistant",
  session_id: "claude-live-1",
  message: { content: [{ type: "text", text }] },
  ...extra,
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

function createSession(fake) {
  const emitted = [];
  const statuses = [];
  const session = new ClaudeAgentSdkSession("claude", {
    cwd: process.cwd(),
    logger: { log: () => {} },
    sdkModule: fake.sdkModule,
  });
  session.setSessionMessageHandler((payload) => emitted.push(payload.text));
  session.setWorkingStatusHandler((payload) => statuses.push(payload));
  return { session, emitted, statuses };
}

describe("claude agent-sdk session: long-lived query", () => {
  it("keeps one claude process with its input open across turns and reports per-turn usage", async () => {
    const fake = createFakeClaude();
    const { session } = createSession(fake);

    const first = session.runTurn("hello");
    const firstPrompt = await fake.nextPrompt();
    assert.equal(firstPrompt.message.content, "hello");
    assert.ok(firstPrompt.uuid);
    fake.current.emit(assistant("hi"));
    fake.current.emit(result("hi", { uuid: firstPrompt.uuid, modelUsage: usage(10, 5) }));
    const firstResult = await first;
    assert.equal(firstResult.text, "hi");
    assert.deepEqual(firstResult.usage, {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    await tick();
    assert.equal(fake.current.inputClosed, false);
    assert.equal(fake.current.closed, 0);

    const second = session.runTurn("again");
    const secondPrompt = await fake.nextPrompt();
    // modelUsage is cumulative for the process.
    fake.current.emit(result("again!", { uuid: secondPrompt.uuid, modelUsage: usage(16, 9) }));
    const secondResult = await second;
    assert.equal(fake.queries.length, 1);
    assert.equal(secondResult.text, "again!");
    assert.deepEqual(secondResult.usage, {
      input_tokens: 6,
      output_tokens: 4,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });

    await session.close();
    assert.equal(fake.current.closed > 0, true);
    await tick();
    assert.equal(fake.current.inputClosed, true);
  });

  it("lets background subagents outlive the turn and streams claude's follow-up turn to the chat", async () => {
    const fake = createFakeClaude();
    const { session, emitted, statuses } = createSession(fake);

    const turn = session.runTurn("start the subagents");
    const prompt = await fake.nextPrompt();
    fake.current.emit(assistant("Subagents launched; waiting."));
    fake.current.emit(result("Subagents launched; waiting.", { uuid: prompt.uuid, modelUsage: usage(10, 5) }));
    assert.equal((await turn).text, "Subagents launched; waiting.");

    // Later, a subagent finishes and claude answers its notification on its own.
    fake.current.emit({ type: "system", subtype: "task_notification", task_id: "a1", status: "completed" });
    fake.current.emit(assistant("All subagents finished: 30/31 nodes pass."));
    fake.current.emit(result("All subagents finished: 30/31 nodes pass.", { modelUsage: usage(40, 25) }));
    await tick();
    await tick();

    assert.deepEqual(emitted, ["Subagents launched; waiting.", "All subagents finished: 30/31 nodes pass."]);
    assert.equal(statuses.at(-1).reply_in_progress, false);
    assert.equal(fake.current.closed, 0);

    // The follow-up turn's tokens are reported with the next user turn.
    const next = session.runTurn("thanks");
    const nextPrompt = await fake.nextPrompt();
    fake.current.emit(result("You're welcome.", { uuid: nextPrompt.uuid, modelUsage: usage(45, 27) }));
    const nextResult = await next;
    assert.deepEqual(nextResult.usage, {
      input_tokens: 35,
      output_tokens: 22,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    assert.equal(fake.queries.length, 1);

    await session.close();
  });

  it("settles a user turn on the result of claude's follow-up turn that folded it in", async () => {
    const fake = createFakeClaude();
    const { session, emitted } = createSession(fake);

    const first = session.runTurn("go");
    const firstPrompt = await fake.nextPrompt();
    fake.current.emit(result("ok", { uuid: firstPrompt.uuid }));
    await first;

    fake.current.emit(assistant("Reading the subagent report."));
    await tick();
    const turn = session.runTurn("status?");
    const prompt = await fake.nextPrompt();
    fake.current.emit(assistant("All done, and to your question: all green."));
    fake.current.emit(result("All done, and to your question: all green.", { uuid: prompt.uuid }));

    assert.equal((await turn).text, "All done, and to your question: all green.");
    await tick();
    assert.deepEqual(emitted, ["ok", "Reading the subagent report.", "All done, and to your question: all green."]);

    await session.close();
  });

  it("does not end a user turn on the result of a follow-up turn running ahead of it", async () => {
    const fake = createFakeClaude();
    const { session } = createSession(fake);

    const first = session.runTurn("go");
    const firstPrompt = await fake.nextPrompt();
    fake.current.emit(result("ok", { uuid: firstPrompt.uuid }));
    await first;

    fake.current.emit(assistant("Handling a subagent notification."));
    await tick();
    let settled = false;
    const turn = session.runTurn("status?").then((value) => {
      settled = true;
      return value;
    });
    const prompt = await fake.nextPrompt();
    fake.current.emit(result("Notification handled."));
    await tick();
    await tick();
    assert.equal(settled, false);

    fake.current.emit(result("Here is the status.", { uuid: prompt.uuid }));
    assert.equal((await turn).text, "Here is the status.");

    await session.close();
  });

  it("does not post subagent narration as a reply", async () => {
    const fake = createFakeClaude();
    const { session, emitted } = createSession(fake);

    const turn = session.runTurn("go");
    const prompt = await fake.nextPrompt();
    fake.current.emit(assistant("Now the pipeline run() code.", { parent_tool_use_id: "toolu_1" }));
    fake.current.emit(assistant("Started."));
    fake.current.emit(result("Started.", { uuid: prompt.uuid }));
    await turn;

    assert.deepEqual(emitted, ["Started."]);
    await session.close();
  });

  it("resumes the session in a new process after claude exits between turns", async () => {
    const fake = createFakeClaude();
    const { session } = createSession(fake);

    const first = session.runTurn("go");
    const firstPrompt = await fake.nextPrompt();
    fake.current.emit(result("ok", { uuid: firstPrompt.uuid }));
    await first;
    fake.current.end();
    await tick();

    const second = session.runTurn("still there?");
    const secondPrompt = await fake.nextPrompt();
    fake.current.emit(result("yes", { uuid: secondPrompt.uuid }));
    assert.equal((await second).text, "yes");
    assert.equal(fake.queries.length, 2);
    assert.equal(fake.queries[1].options.resume, "claude-live-1");

    await session.close();
  });

  it("interrupts the running turn without tearing the process down", async () => {
    const fake = createFakeClaude();
    const { session } = createSession(fake);

    const turn = session.runTurn("long task");
    const prompt = await fake.nextPrompt();
    assert.equal(await session.interruptCurrentTurn(), true);
    assert.equal(fake.current.interrupts, 1);
    fake.current.emit({ ...result("", { uuid: prompt.uuid, subtype: "error_during_execution" }), errors: ["interrupted"] });

    await assert.rejects(turn, /interrupted/);
    assert.equal(fake.current.closed, 0);

    await session.close();
  });
});
