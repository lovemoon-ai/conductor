import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ClaudeAgentSdkSession } from "../src/session-factory.js";
import {
  resolveClaudeCommandForRoot,
  resolveClaudePermissionPolicy,
} from "../src/providers/claude-agent-sdk-session.js";

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

  it("runGoal prepends '/goal ' to the prompt and wraps the result as GoalResult", async () => {
    const capturedPrompts = [];
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger: { log: () => {} },
      sdkModule: {
        query: ({ prompt }) => {
          capturedPrompts.push(prompt);
          return {
            async *[Symbol.asyncIterator]() {
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
    assert.equal(policy.downgradedFrom, "");
    assert.equal(policy.invalidMode, "");
  });

  it("reports an unknown mode without failing the session", () => {
    const policy = resolveClaudePermissionPolicy({ permissionMode: "auto" }, {});
    assert.equal(policy.invalidMode, "auto");
    assert.equal(policy.permissionMode, "bypassPermissions");
  });

  it("reports an unknown mode as root too, after the root fallback", () => {
    const policy = asRoot(() => resolveClaudePermissionPolicy({ permissionMode: "auto" }, {}));
    assert.equal(policy.invalidMode, "auto");
    assert.equal(policy.permissionMode, "acceptEdits");
  });

  it("downgrades bypassPermissions to acceptEdits when running as root", () => {
    const policy = asRoot(() => resolveClaudePermissionPolicy({}, {}));
    assert.equal(policy.permissionMode, "acceptEdits");
    assert.equal(policy.allowDangerouslySkipPermissions, false);
    assert.equal(policy.downgradedFrom, "bypassPermissions");
  });

  it("never forces --dangerously-skip-permissions as root", () => {
    const policy = asRoot(() =>
      resolveClaudePermissionPolicy({ permissionMode: "plan", allowDangerouslySkipPermissions: true }, {}),
    );
    assert.equal(policy.permissionMode, "plan");
    assert.equal(policy.allowDangerouslySkipPermissions, false);
    assert.equal(policy.downgradedFrom, "");
  });

  it("keeps bypassPermissions as root when IS_SANDBOX is set", () => {
    const policy = asRoot(() => resolveClaudePermissionPolicy({}, { IS_SANDBOX: "1" }));
    assert.equal(policy.permissionMode, "bypassPermissions");
    assert.equal(policy.allowDangerouslySkipPermissions, true);
    assert.equal(policy.downgradedFrom, "");
  });

  // claude's root gate compares IS_SANDBOX with a strict === "1". Accepting
  // "true"/"yes" here would keep bypassPermissions and let claude exit(1).
  it("still downgrades as root for IS_SANDBOX values claude does not accept", () => {
    for (const value of ["true", "yes", "on", "0", ""]) {
      const policy = asRoot(() => resolveClaudePermissionPolicy({}, { IS_SANDBOX: value }));
      assert.equal(policy.permissionMode, "acceptEdits", `IS_SANDBOX=${JSON.stringify(value)}`);
    }
  });

  // CLAUDE_CODE_BUBBLEWRAP is the other half of the gate, and it *does* go
  // through claude's loose truthy parser.
  it("keeps bypassPermissions as root under CLAUDE_CODE_BUBBLEWRAP", () => {
    for (const value of ["1", "true", "YES", " on "]) {
      const policy = asRoot(() => resolveClaudePermissionPolicy({}, { CLAUDE_CODE_BUBBLEWRAP: value }));
      assert.equal(policy.permissionMode, "bypassPermissions", `CLAUDE_CODE_BUBBLEWRAP=${value}`);
    }
    const off = asRoot(() => resolveClaudePermissionPolicy({}, { CLAUDE_CODE_BUBBLEWRAP: "0" }));
    assert.equal(off.permissionMode, "acceptEdits");
  });

  it("honors an explicit permission mode as root without downgrading", () => {
    const policy = asRoot(() => resolveClaudePermissionPolicy({ permissionMode: "acceptEdits" }, {}));
    assert.equal(policy.permissionMode, "acceptEdits");
    assert.equal(policy.downgradedFrom, "");
  });
});

describe("claude command line root fallback", () => {
  const asRoot = (fn) => {
    const original = process.getuid;
    process.getuid = () => 0;
    try {
      return fn();
    } finally {
      process.getuid = original;
    }
  };

  it("leaves the command untouched when not running as root", () => {
    const command = "claude --dangerously-skip-permissions";
    assert.equal(resolveClaudeCommandForRoot(command, {}), command);
  });

  it("swaps --dangerously-skip-permissions for auto mode as root", () => {
    const result = asRoot(() => resolveClaudeCommandForRoot("claude --dangerously-skip-permissions", {}));
    assert.equal(result, "claude --permission-mode acceptEdits");
  });

  it("preserves unrelated flags while stripping the dangerous one", () => {
    const result = asRoot(() =>
      resolveClaudeCommandForRoot("claude --dangerously-skip-permissions --model fable --effort low", {}),
    );
    assert.equal(result, "claude --model fable --effort low --permission-mode acceptEdits");
  });

  it("rewrites an explicit bypassPermissions mode as root", () => {
    assert.equal(
      asRoot(() => resolveClaudeCommandForRoot("claude --permission-mode bypassPermissions", {})),
      "claude --permission-mode acceptEdits",
    );
    assert.equal(
      asRoot(() => resolveClaudeCommandForRoot("claude --permission-mode=bypassPermissions", {})),
      "claude --permission-mode=acceptEdits",
    );
  });

  it("honors a root-safe mode the user already configured", () => {
    const command = "claude --permission-mode plan";
    assert.equal(asRoot(() => resolveClaudeCommandForRoot(command, {})), command);
  });

  it("keeps the dangerous flag as root when IS_SANDBOX=1", () => {
    const command = "claude --dangerously-skip-permissions";
    assert.equal(asRoot(() => resolveClaudeCommandForRoot(command, { IS_SANDBOX: "1" })), command);
  });

  it("repairs a valueless --permission-mode instead of doubling the flag", () => {
    assert.equal(
      asRoot(() => resolveClaudeCommandForRoot("claude --permission-mode", {})),
      "claude --permission-mode acceptEdits",
    );
    assert.equal(
      asRoot(() => resolveClaudeCommandForRoot("claude --permission-mode=", {})),
      "claude --permission-mode acceptEdits",
    );
    assert.equal(
      asRoot(() => resolveClaudeCommandForRoot("claude --permission-mode --model fable", {})),
      "claude --model fable --permission-mode acceptEdits",
    );
  });

  it("tolerates empty and non-string command lines", () => {
    assert.equal(asRoot(() => resolveClaudeCommandForRoot("", {})), "");
    assert.equal(asRoot(() => resolveClaudeCommandForRoot(undefined, {})), "");
  });
});
