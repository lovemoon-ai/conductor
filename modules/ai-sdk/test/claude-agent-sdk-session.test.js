import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ClaudeAgentSdkSession } from "../src/session-factory.js";
import {
  buildClaudeRootSandboxNotice,
  claudeCommandNeedsRootSandbox,
  resolveClaudePermissionPolicy,
} from "../src/providers/claude-agent-sdk-session.js";

// A turn's prompt reaches the SDK as a stream of user messages; read the first.
async function firstPromptText(prompt) {
  const { value } = await prompt[Symbol.asyncIterator]().next();
  return value?.message?.content;
}

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

  it("attaches a failed turn's usage to the thrown error", async () => {
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: {
        query: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "result",
              subtype: "error_during_execution",
              session_id: "claude-session-1",
              usage: { input_tokens: 3, output_tokens: 2 },
              errors: ["interrupted"],
            };
          },
          close: () => {},
        }),
      },
    });

    await assert.rejects(session.runTurn("hello"), (error) => {
      assert.deepEqual(error.usage, { input_tokens: 3, output_tokens: 2 });
      return true;
    });

    await session.close();
  });

  it("falls back to streamed usage when an interrupted query ends without a result", async () => {
    const assistant = (id, usage) => ({
      type: "assistant",
      session_id: "claude-session-1",
      message: { id, content: [{ type: "tool_use", id: `tool-${id}`, name: "Bash", input: {} }], usage },
    });
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: {
        query: () => ({
          async *[Symbol.asyncIterator]() {
            // One API response streams one message per content block, repeating its usage.
            yield assistant("msg-1", { input_tokens: 2, cache_read_input_tokens: 100, output_tokens: 5 });
            yield assistant("msg-1", { input_tokens: 2, cache_read_input_tokens: 100, output_tokens: 5 });
            yield assistant("msg-2", { input_tokens: 1, cache_read_input_tokens: 200, output_tokens: 3 });
          },
          close: () => {},
        }),
      },
    });

    await assert.rejects(session.runTurn("hello"), (error) => {
      assert.equal(error.reason, "missing_result");
      assert.deepEqual(error.usage, { input_tokens: 3, cache_read_input_tokens: 300, output_tokens: 8 });
      return true;
    });

    await session.close();
  });

  it("keeps a stopped turn's streamed usage on the session-closed error", async () => {
    let session;
    session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: {
        query: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "assistant",
              session_id: "claude-session-1",
              message: { id: "msg-1", content: [], usage: { input_tokens: 4, output_tokens: 6 } },
            };
            // Stopping the task aborts the query, which fails with its own error.
            session.closeRequested = true;
            throw new Error("The operation was aborted");
          },
          close: () => {},
        }),
      },
    });

    await assert.rejects(session.runTurn("hello"), (error) => {
      assert.equal(error.reason, "session_closed");
      assert.deepEqual(error.usage, { input_tokens: 4, output_tokens: 6 });
      return true;
    });
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

  it("runCompact sends the native /compact command on the resumed session without emitting a reply", async () => {
    const captured = [];
    const emitted = [];
    const progress = [];
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      resumeSessionId: "claude-compact-1",
      logger: { log: () => {} },
      sdkModule: {
        query: ({ prompt, options }) => {
          return {
            async *[Symbol.asyncIterator]() {
              captured.push({ prompt: await firstPromptText(prompt), resume: options.resume });
              yield { type: "system", subtype: "status", status: "compacting", session_id: "claude-compact-1" };
              yield {
                type: "system",
                subtype: "compact_boundary",
                session_id: "claude-compact-1",
                compact_metadata: { trigger: "manual", pre_tokens: 52000, post_tokens: 3100 },
              };
              yield { type: "system", subtype: "status", status: null, compact_result: "success", session_id: "claude-compact-1" };
              yield {
                type: "assistant",
                session_id: "claude-compact-1",
                message: { content: [{ type: "text", text: "Compacted." }] },
              };
              yield { type: "result", subtype: "success", session_id: "claude-compact-1", result: "Compacted.", usage: { input_tokens: 5 } };
            },
            close: () => {},
          };
        },
      },
    });
    session.setSessionMessageHandler((payload) => emitted.push(payload));

    const result = await session.runCompact(
      { instructions: "  keep the API decisions  " },
      { onProgress: (payload) => progress.push(payload) },
    );

    assert.deepEqual(captured, [{ prompt: "/compact keep the API decisions", resume: "claude-compact-1" }]);
    assert.deepEqual(result.compact, {
      status: "compacted",
      instructionsApplied: true,
      preTokens: 52000,
      postTokens: 3100,
    });
    assert.equal(emitted.length, 0);
    assert.deepEqual(session.history, []);
    assert.equal(progress.some((payload) => payload.phase === "context_compaction"), true);
    await session.close();
  });

  it("runClear sends the native /clear command and adopts the new session id", async () => {
    const captured = [];
    const emitted = [];
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      resumeSessionId: "claude-clear-1",
      logger: { log: () => {} },
      sdkModule: {
        query: ({ prompt, options }) => {
          return {
            async *[Symbol.asyncIterator]() {
              captured.push({ prompt: await firstPromptText(prompt), resume: options.resume });
              // The CLI answers the slash command itself and moves to a new session.
              yield { type: "system", subtype: "init", session_id: "claude-clear-2" };
              yield { type: "result", subtype: "success", session_id: "claude-clear-2", result: "(no content)", usage: { input_tokens: 3 } };
            },
            close: () => {},
          };
        },
      },
    });
    session.setSessionMessageHandler((payload) => emitted.push(payload));

    const result = await session.runClear();

    assert.deepEqual(captured, [{ prompt: "/clear", resume: "claude-clear-1" }]);
    assert.deepEqual(result.clear, { status: "cleared", sessionId: "claude-clear-2" });
    assert.equal(emitted.length, 0, "the clear must not surface an assistant reply");
    assert.deepEqual(session.history, []);
    await session.close();
  });

  it("runClear trusts the SDK's conversation_reset signal", async () => {
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      resumeSessionId: "claude-clear-reset",
      logger: { log: () => {} },
      sdkModule: {
        query: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "conversation_reset", new_conversation_id: "claude-clear-reset-2", session_id: "claude-clear-reset" };
            yield { type: "result", subtype: "success", session_id: "claude-clear-reset-2", result: "", usage: {} };
          },
          close: () => {},
        }),
      },
    });

    const result = await session.runClear();

    assert.deepEqual(result.clear, { status: "cleared", sessionId: "claude-clear-reset-2" });
    await session.close();
  });

  it("runClear reports a noop when the session id did not move", async () => {
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      resumeSessionId: "claude-clear-3",
      logger: { log: () => {} },
      sdkModule: {
        query: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "result", subtype: "success", session_id: "claude-clear-3", result: "I cannot do that.", usage: {} };
          },
          close: () => {},
        }),
      },
    });

    const result = await session.runClear();

    assert.equal(result.clear.status, "noop");
    assert.equal(result.clear.sessionId, undefined);
    await session.close();
  });

  it("runClear is a noop before the conversation has a session", async () => {
    let queried = false;
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: {
        query: () => {
          queried = true;
          throw new Error("should not query");
        },
      },
    });

    const result = await session.runClear();

    assert.equal(queried, false);
    assert.equal(result.clear.status, "noop");
    await session.close();
  });

  it("advertises the clear capability", () => {
    assert.equal(ClaudeAgentSdkSession.capabilities.clear, true);
  });

  it("runCompact is a noop before the conversation has a session", async () => {
    let queried = false;
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: {
        query: () => {
          queried = true;
          throw new Error("should not query");
        },
      },
    });

    const result = await session.runCompact({});

    assert.equal(queried, false);
    assert.deepEqual(result.compact, { status: "noop", instructionsApplied: false });
    await session.close();
  });

  it("runCompact surfaces a failed compaction and treats a too-short conversation as a noop", async () => {
    let compactError = "API Error: overloaded";
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      resumeSessionId: "claude-compact-2",
      logger: { log: () => {} },
      sdkModule: {
        query: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "system",
              subtype: "status",
              status: null,
              compact_result: "failed",
              compact_error: compactError,
              session_id: "claude-compact-2",
            };
            yield { type: "result", subtype: "success", session_id: "claude-compact-2", result: "" };
          },
          close: () => {},
        }),
      },
    });

    await assert.rejects(session.runCompact({}), (error) => {
      assert.equal(error.reason, "compact_failed");
      assert.match(error.message, /overloaded/);
      return true;
    });

    compactError = "Not enough messages to compact.";
    const result = await session.runCompact({});
    assert.deepEqual(result.compact, { status: "noop", instructionsApplied: false });
    await session.close();
  });

  it("runGoal prepends '/goal ' to the prompt and wraps the result as GoalResult", async () => {
    const capturedPrompts = [];
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: {
        query: ({ prompt }) => {
          return {
            async *[Symbol.asyncIterator]() {
              capturedPrompts.push(await firstPromptText(prompt));
              yield {
                type: "result",
                subtype: "success",
                session_id: "claude-goal-1",
                usage: { input_tokens: 1, output_tokens: 1 },
                result: "started working on the goal",
              };
            },
            close: () => {},
          };
        },
      },
    });

    const result = await session.runGoal({ objective: "ship the release" });

    assert.equal(capturedPrompts.length, 1);
    assert.equal(capturedPrompts[0].startsWith("/goal "), true);
    assert.equal(capturedPrompts[0], "/goal ship the release");
    assert.equal(result.text, "started working on the goal");
    assert.equal(result.goal.objective, "ship the release");
    assert.equal(result.goal.status, "active");
    assert.equal(result.goal.threadId, "claude-goal-1");
    assert.equal(result.metadata.goalPrompt, "/goal ship the release");

    await session.close();
  });

  it("runGoal parses goal_status items from the SDK message stream", async () => {
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: {
        query: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "goal_status",
              goal_status: {
                id: "g-1",
                status: "complete",
                tokenBudget: 5000,
              },
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "claude-goal-2",
              usage: null,
              result: "done",
            };
          },
          close: () => {},
        }),
      },
    });

    const result = await session.runGoal({ objective: "ship the release" });

    assert.equal(result.goal.status, "complete");
    assert.equal(result.goal.id, "g-1");
    // explicit goal.tokenBudget on the request takes precedence; here we did not supply one
    assert.equal(result.goal.tokenBudget, 5000);

    await session.close();
  });

  it("runGoal returns the terminal goal_status when the SDK emits multiple status items (N8)", async () => {
    // The Claude SDK's `query()` iterator is drained to completion by
    // `runTurn`, so by the time `runGoal` inspects `turnResult.items` the
    // full conversation is buffered. If the SDK emits an intermediate
    // "active" goal_status followed by a terminal "complete" one, we must
    // surface the terminal one — picking the first would mis-report the
    // goal as still running.
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: {
        query: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "goal_status",
              goal_status: { id: "g-multi", status: "active", tokenBudget: 5000 },
            };
            yield {
              type: "goal_status",
              goal_status: { id: "g-multi", status: "complete", tokenBudget: 5000 },
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "claude-goal-multi",
              usage: null,
              result: "all done",
            };
          },
          close: () => {},
        }),
      },
    });

    const result = await session.runGoal({ objective: "ship the release" });

    assert.equal(result.goal.status, "complete");
    assert.equal(result.goal.id, "g-multi");
    assert.equal(result.text, "all done");

    await session.close();
  });

  it("runGoal defaults to 'active' when the SDK emits an unknown goal_status", async () => {
    // Defense in depth: if the Claude SDK adds a new status value (or sends a
    // typo'd one), we should NOT leak it through as the goal's status. The
    // realtime hub uses isTerminalGoalStatus to decide when to stop polling,
    // so a value like "weird" would either be silently treated as non-terminal
    // (false positive "still active") or accidentally hit a terminal branch
    // depending on consumer. Default to "active" so the polling loop stays
    // safe and the bad value never escapes.
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: {
        query: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "goal_status",
              goal_status: {
                id: "g-weird",
                status: "weird",
                tokenBudget: 100,
              },
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "claude-goal-weird",
              usage: null,
              result: "ok",
            };
          },
          close: () => {},
        }),
      },
    });

    const result = await session.runGoal({ objective: "ship the release" });

    assert.equal(result.goal.status, "active");
    // The valid sibling fields should still come through.
    assert.equal(result.goal.id, "g-weird");
    assert.equal(result.goal.tokenBudget, 100);

    await session.close();
  });

  it("runGoal rejects empty objectives", async () => {
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: {
        query: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "result", subtype: "success", result: "" };
          },
          close: () => {},
        }),
      },
    });

    await assert.rejects(() => session.runGoal({ objective: "  " }), /non-empty objective/);

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

  it("advertises goal capability via getSnapshot().capabilities", () => {
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
    });
    assert.equal(session.getCapabilities().goal, true);
    assert.equal(session.getSnapshot().capabilities?.goal, true);
    assert.equal(ClaudeAgentSdkSession.capabilities.goal, true);
  });

  it("lifts --effort out of the configured commandLine when not passed explicitly", () => {
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      commandLine: "claude --model fable --effort low",
    });
    assert.equal(session.options.effort, "low");
  });

  it("supports --effort=value syntax in commandLine", () => {
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      commandLine: "claude --model=fable --effort=high",
    });
    assert.equal(session.options.effort, "high");
  });

  it("prefers explicit options.effort over commandLine-derived effort", () => {
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      effort: "medium",
      commandLine: "claude --model fable --effort low",
    });
    assert.equal(session.options.effort, "medium");
  });

  it("forwards commandLine-derived effort through buildSdkOptions passthrough", () => {
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      commandLine: "claude --model fable --effort low",
    });
    const sdkOptions = session.buildSdkOptions(new AbortController());
    assert.equal(sdkOptions.effort, "low");
  });

  it("leaves effort unset when commandLine has no --effort flag", () => {
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      commandLine: "claude --model fable",
    });
    assert.equal(session.options.effort, undefined);
  });

  it("lifts --permission-mode out of the configured commandLine", () => {
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      commandLine: "claude --permission-mode acceptEdits",
    });
    const sdkOptions = session.buildSdkOptions(new AbortController());
    assert.equal(sdkOptions.permissionMode, "acceptEdits");
    assert.equal(sdkOptions.allowDangerouslySkipPermissions, undefined);
  });

  it("warns and falls back to the default when the configured mode is unknown", () => {
    const logs = [];
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: (line) => logs.push(String(line)) },
      commandLine: "claude --permission-mode auto",
    });
    const sdkOptions = session.buildSdkOptions(new AbortController());
    assert.equal(sdkOptions.permissionMode, "bypassPermissions");
    const warning = logs.find((line) => line.includes("WARN unknown permission mode"));
    assert.ok(warning, `expected a warning, got: ${logs.join(" | ")}`);
    assert.match(warning, /"auto"/);
    assert.match(warning, /valid: default, acceptEdits, bypassPermissions, plan, dontAsk/);
  });

  it("stays quiet when the configured mode is valid", () => {
    const logs = [];
    new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: (line) => logs.push(String(line)) },
      commandLine: "claude --permission-mode acceptEdits",
    });
    assert.equal(logs.filter((line) => line.includes("permission mode")).length, 0);
  });

  it("prefers explicit options.permissionMode over commandLine-derived mode", () => {
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      permissionMode: "plan",
      commandLine: "claude --permission-mode acceptEdits",
    });
    assert.equal(session.options.permissionMode, "plan");
  });
});

describe("claude permission policy", () => {
  const asRoot = (fn) => {
    const original = process.getuid;
    process.getuid = () => 0;
    try {
      return fn();
    } finally {
      process.getuid = original;
    }
  };

  it("keeps bypassPermissions by default for non-root", () => {
    const policy = resolveClaudePermissionPolicy({}, {});
    assert.equal(policy.permissionMode, "bypassPermissions");
    assert.equal(policy.allowDangerouslySkipPermissions, true);
    assert.equal(policy.rootSandboxRequired, false);
    assert.equal(policy.invalidMode, "");
  });

  it("reports an unknown mode without failing the session", () => {
    const policy = resolveClaudePermissionPolicy({ permissionMode: "auto" }, {});
    assert.equal(policy.invalidMode, "auto");
    assert.equal(policy.permissionMode, "bypassPermissions");
  });

  // A headless acceptEdits session silently denies every shell command, so
  // root no longer downgrades: the mode is kept and the caller warns instead.
  it("keeps bypassPermissions as root and flags that IS_SANDBOX is required", () => {
    const policy = asRoot(() => resolveClaudePermissionPolicy({}, {}));
    assert.equal(policy.permissionMode, "bypassPermissions");
    assert.equal(policy.allowDangerouslySkipPermissions, true);
    assert.equal(policy.rootSandboxRequired, true);
  });

  it("reports an unknown mode as root and keeps the default mode", () => {
    const policy = asRoot(() => resolveClaudePermissionPolicy({ permissionMode: "auto" }, {}));
    assert.equal(policy.invalidMode, "auto");
    assert.equal(policy.permissionMode, "bypassPermissions");
    assert.equal(policy.rootSandboxRequired, true);
  });

  it("does not need IS_SANDBOX as root when IS_SANDBOX=1", () => {
    const policy = asRoot(() => resolveClaudePermissionPolicy({}, { IS_SANDBOX: "1" }));
    assert.equal(policy.permissionMode, "bypassPermissions");
    assert.equal(policy.allowDangerouslySkipPermissions, true);
    assert.equal(policy.rootSandboxRequired, false);
  });

  // claude's root gate compares IS_SANDBOX with a strict === "1".
  it("still requires IS_SANDBOX as root for values claude does not accept", () => {
    for (const value of ["true", "yes", "on", "0", ""]) {
      const policy = asRoot(() => resolveClaudePermissionPolicy({}, { IS_SANDBOX: value }));
      assert.equal(policy.rootSandboxRequired, true, `IS_SANDBOX=${JSON.stringify(value)}`);
      assert.equal(policy.permissionMode, "bypassPermissions");
    }
  });

  // CLAUDE_CODE_BUBBLEWRAP is the other half of the gate, and it *does* go
  // through claude's loose truthy parser.
  it("does not need IS_SANDBOX as root under CLAUDE_CODE_BUBBLEWRAP", () => {
    for (const value of ["1", "true", "YES", " on "]) {
      const policy = asRoot(() => resolveClaudePermissionPolicy({}, { CLAUDE_CODE_BUBBLEWRAP: value }));
      assert.equal(policy.rootSandboxRequired, false, `CLAUDE_CODE_BUBBLEWRAP=${value}`);
    }
    const off = asRoot(() => resolveClaudePermissionPolicy({}, { CLAUDE_CODE_BUBBLEWRAP: "0" }));
    assert.equal(off.rootSandboxRequired, true);
  });

  it("honors an explicit non-bypass mode as root without a warning", () => {
    const policy = asRoot(() => resolveClaudePermissionPolicy({ permissionMode: "acceptEdits" }, {}));
    assert.equal(policy.permissionMode, "acceptEdits");
    assert.equal(policy.allowDangerouslySkipPermissions, false);
    assert.equal(policy.rootSandboxRequired, false);
  });

  it("never adds the escape flag to a non-bypass mode as root", () => {
    const policy = asRoot(() =>
      resolveClaudePermissionPolicy({ permissionMode: "plan", allowDangerouslySkipPermissions: true }, {}),
    );
    assert.equal(policy.permissionMode, "plan");
    assert.equal(policy.allowDangerouslySkipPermissions, false);
    assert.equal(policy.rootSandboxRequired, false);
  });
});

describe("claude root sandbox notice", () => {
  const asRoot = (fn) => {
    const original = process.getuid;
    process.getuid = () => 0;
    try {
      return fn();
    } finally {
      process.getuid = original;
    }
  };

  it("tells the user to set envs.IS_SANDBOX to the string \"1\" in their config", () => {
    const notice = buildClaudeRootSandboxNotice({ configFile: "/root/.conductor/config.yaml" });
    assert.match(notice, /\/root\/\.conductor\/config\.yaml/);
    assert.match(notice, /envs:\n {2}IS_SANDBOX: "1"/);
    assert.match(notice, /root/);
  });

  it("falls back to the default config path", () => {
    assert.match(buildClaudeRootSandboxNotice(), /~\/\.conductor\/config\.yaml/);
  });

  it("exposes the notice on the session snapshot when root needs IS_SANDBOX", () => {
    const logs = [];
    const session = asRoot(() => new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: (line) => logs.push(String(line)) },
      env: { IS_SANDBOX: "" },
    }));
    const snapshot = session.getSnapshot();
    assert.equal(snapshot.notices.length, 1);
    assert.match(snapshot.notices[0], /IS_SANDBOX: "1"/);
    assert.ok(logs.some((line) => line.includes("WARN running as root without IS_SANDBOX=1")), logs.join(" | "));
    const sdkOptions = session.buildSdkOptions(new AbortController());
    assert.equal(sdkOptions.permissionMode, "bypassPermissions");
    assert.equal(sdkOptions.allowDangerouslySkipPermissions, true);
  });

  it("has no notice as root with IS_SANDBOX=1, or when not root", () => {
    const sandboxed = asRoot(() => new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      env: { IS_SANDBOX: "1" },
    }));
    assert.deepEqual(sandboxed.getSnapshot().notices, []);
    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      const regular = new ClaudeAgentSdkSession("claude", { cwd: process.cwd(), logger: { log: () => {} } });
      assert.deepEqual(regular.getSnapshot().notices, []);
    }
  });

  it("detects bypass command lines that will hit claude's root gate", () => {
    assert.equal(asRoot(() => claudeCommandNeedsRootSandbox("claude --dangerously-skip-permissions", {})), true);
    assert.equal(
      asRoot(() => claudeCommandNeedsRootSandbox("claude --permission-mode bypassPermissions", {})),
      true,
    );
    assert.equal(asRoot(() => claudeCommandNeedsRootSandbox("claude --permission-mode plan", {})), false);
    assert.equal(asRoot(() => claudeCommandNeedsRootSandbox("claude", {})), false);
    assert.equal(
      asRoot(() => claudeCommandNeedsRootSandbox("claude --dangerously-skip-permissions", { IS_SANDBOX: "1" })),
      false,
    );
    assert.equal(asRoot(() => claudeCommandNeedsRootSandbox("", {})), false);
    assert.equal(asRoot(() => claudeCommandNeedsRootSandbox(undefined, {})), false);
  });
});
