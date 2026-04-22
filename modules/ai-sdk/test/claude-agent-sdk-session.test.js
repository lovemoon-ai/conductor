import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ClaudeAgentSdkSession } from "../src/session-factory.js";

describe("claude agent-sdk session", () => {
  it("exposes optional modelProvider metadata", async () => {
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      model: "claude-sonnet-4-20250514",
      logger: { log: () => {} },
      sdkModule: {
        query: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "result",
              subtype: "success",
              session_id: "claude-session-1",
              total_cost_usd: 0.01,
              usage: { input_tokens: 1, output_tokens: 1 },
              modelUsage: {
                model: "claude-sonnet-4-20250514",
              },
              result: "ok",
            };
          },
          close: () => {},
        }),
      },
    });

    const result = await session.runTurn("hello");

    assert.equal(result.text, "ok");
    assert.equal(session.getSessionInfo()?.model, "claude-sonnet-4-20250514");
    assert.equal(session.getSessionInfo()?.modelProvider, undefined);
    assert.equal(session.threadOptions.model, "claude-sonnet-4-20250514");
    assert.equal(session.threadOptions.modelProvider, undefined);

    await session.close();
  });

  it("emits a terminal working status when the Claude process exits before a result", async () => {
    const progressPayloads = [];
    const eventPayloads = [];
    let closeCount = 0;

    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: {
        query: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "status",
              status: "compacting",
            };
            throw new Error("Claude Code process exited with code 1");
          },
          close: () => {
            closeCount += 1;
          },
        }),
      },
    });

    session.setWorkingStatusHandler(async (payload) => {
      eventPayloads.push(payload);
    });

    await assert.rejects(
      () =>
        session.runTurn("hello", {
          onProgress: (payload) => {
            progressPayloads.push(payload);
          },
        }),
      /Claude Code process exited with code 1/,
    );

    const lastProgressPayload = progressPayloads.at(-1);
    const lastEventPayload = eventPayloads.at(-1);

    assert.ok(progressPayloads.some((payload) => payload.status_line === "claude is working"));
    assert.ok(eventPayloads.some((payload) => payload.status_line === "claude is working"));
    assert.equal(lastProgressPayload?.reply_in_progress, false);
    assert.equal(lastEventPayload?.reply_in_progress, false);
    assert.equal(lastProgressPayload?.status_done_line, "Claude Code process exited with code 1");
    assert.equal(lastEventPayload?.status_done_line, "Claude Code process exited with code 1");
    assert.equal(closeCount > 0, true);

    await session.close();
  });

  it("returns structured_output as JSON text when jsonSchema is requested", async () => {
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: {
        query: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "result",
              subtype: "success",
              session_id: "claude-session-structured",
              usage: { input_tokens: 1, output_tokens: 1 },
              result: "",
              structured_output: {
                backend: "claude",
                ok: true,
              },
            };
          },
          close: () => {},
        }),
      },
    });

    const result = await session.runTurn("hello", {
      jsonSchema: {
        type: "object",
        properties: {
          backend: { type: "string" },
          ok: { type: "boolean" },
        },
        required: ["backend", "ok"],
        additionalProperties: false,
      },
    });

    assert.deepEqual(JSON.parse(result.text), {
      backend: "claude",
      ok: true,
    });
    assert.deepEqual(result.metadata?.structuredOutput, {
      backend: "claude",
      ok: true,
    });

    await session.close();
  });
});
