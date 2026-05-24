import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BridgeRunner,
  GOAL_CAPABLE_BACKENDS,
  parseGoalDirectiveFromMessage,
} from "../bin/conductor-fire.js";
import { buildFireSpawnArgs } from "../src/daemon.js";

function buildConductorStub({ sendRuntimeStatus } = {}) {
  return {
    sendMessage: async () => ({}),
    sendRuntimeStatus:
      typeof sendRuntimeStatus === "function" ? sendRuntimeStatus : async () => ({}),
    ackMessages: async () => ({}),
    receiveMessages: async () => ({ messages: [] }),
  };
}

let uniqueTaskCounter = 0;
function uniqueTaskId(prefix = "task-goal") {
  uniqueTaskCounter += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${uniqueTaskCounter}`;
}

function makeGoalCapableSession({ runGoal, runTurn } = {}) {
  return {
    getSnapshot: () => ({ capabilities: { goal: true } }),
    runGoal:
      typeof runGoal === "function" ? runGoal : async () => ({ text: "goal-reply" }),
    runTurn:
      typeof runTurn === "function" ? runTurn : async () => ({ text: "turn-reply" }),
  };
}

function makeNonGoalCapableSession({ runGoal, runTurn } = {}) {
  return {
    getSnapshot: () => ({ capabilities: { goal: false } }),
    runGoal:
      typeof runGoal === "function" ? runGoal : async () => ({ text: "goal-reply" }),
    runTurn:
      typeof runTurn === "function" ? runTurn : async () => ({ text: "turn-reply" }),
  };
}

function buildRunner({ backendSession, conductor, taskId } = {}) {
  return new BridgeRunner({
    backendSession,
    conductor: conductor || buildConductorStub(),
    taskId: taskId || uniqueTaskId(),
    pollIntervalMs: 500,
    initialPrompt: "",
    includeInitialImages: false,
    cliArgs: [],
    backendName: "codex",
  });
}

describe("GOAL_CAPABLE_BACKENDS", () => {
  it("exposes the curated list used by session-creation gating", () => {
    assert.ok(Array.isArray(GOAL_CAPABLE_BACKENDS));
    assert.ok(GOAL_CAPABLE_BACKENDS.includes("claude"));
    assert.ok(GOAL_CAPABLE_BACKENDS.includes("codex"));
  });
});

describe("parseGoalDirectiveFromMessage", () => {
  it("returns null for non-string / empty input", () => {
    assert.equal(parseGoalDirectiveFromMessage(undefined), null);
    assert.equal(parseGoalDirectiveFromMessage(null), null);
    assert.equal(parseGoalDirectiveFromMessage(123), null);
    assert.equal(parseGoalDirectiveFromMessage(""), null);
    assert.equal(parseGoalDirectiveFromMessage("   \n\n  "), null);
  });

  it("returns null when there is no /goal directive", () => {
    assert.equal(parseGoalDirectiveFromMessage("hello"), null);
    assert.equal(parseGoalDirectiveFromMessage("help me ship"), null);
  });

  it("returns null when /goal is not on the first non-empty line", () => {
    assert.equal(parseGoalDirectiveFromMessage("hello /goal ship"), null);
    assert.equal(parseGoalDirectiveFromMessage("hi\n/goal ship"), null);
  });

  it("returns null when /goal is not followed by whitespace (no /goalfoo)", () => {
    assert.equal(parseGoalDirectiveFromMessage("/goalsomething"), null);
    assert.equal(parseGoalDirectiveFromMessage("/goalship"), null);
  });

  it("matches /goal with inline text", () => {
    assert.deepEqual(parseGoalDirectiveFromMessage("/goal ship it"), { objective: "ship it" });
  });

  it("trims leading whitespace before the directive", () => {
    assert.deepEqual(parseGoalDirectiveFromMessage("  /goal ship it"), { objective: "ship it" });
  });

  it("skips leading blank lines before the directive line", () => {
    assert.deepEqual(
      parseGoalDirectiveFromMessage("\n\n   \n/goal ship it"),
      { objective: "ship it" },
    );
  });

  it("is case-insensitive on the keyword", () => {
    assert.deepEqual(parseGoalDirectiveFromMessage("/Goal ship it"), { objective: "ship it" });
    assert.deepEqual(parseGoalDirectiveFromMessage("/GOAL ship it"), { objective: "ship it" });
  });

  it("combines inline text and remaining body with a blank line", () => {
    assert.deepEqual(
      parseGoalDirectiveFromMessage("/goal ship it\nmore detail\nand more"),
      { objective: "ship it\n\nmore detail\nand more" },
    );
  });

  it("uses the rest of the body as the objective when only /goal is on the first line", () => {
    assert.deepEqual(
      parseGoalDirectiveFromMessage("/goal\nship it\n\nbecause reasons"),
      { objective: "ship it\n\nbecause reasons" },
    );
  });

  it("returns null when the directive carries no objective at all", () => {
    assert.equal(parseGoalDirectiveFromMessage("/goal"), null);
    assert.equal(parseGoalDirectiveFromMessage("/goal\n\n"), null);
    assert.equal(parseGoalDirectiveFromMessage("/goal   "), null);
  });
});

describe("daemon buildFireSpawnArgs (no --goal flag)", () => {
  it("never appends --goal regardless of launch_config aiMode", () => {
    const args = buildFireSpawnArgs({
      selectedBackend: "codex",
      initialContent: "hello",
      launchConfig: { aiMode: "goal", goal: { objective: "ship it", source: "issue" } },
    });
    assert.ok(!args.includes("--goal"), "--goal flag must not be appended");
  });

  it("passes the initialContent through as --prefill verbatim", () => {
    const args = buildFireSpawnArgs({
      selectedBackend: "codex",
      initialContent: "/goal ship it\n\nmore detail",
      launchConfig: {},
    });
    const prefillIndex = args.indexOf("--prefill");
    assert.ok(prefillIndex >= 0);
    assert.equal(args[prefillIndex + 1], "/goal ship it\n\nmore detail");
    assert.ok(!args.includes("--goal"));
  });

  it("falls back to launch_config.goal.objective when initialContent is empty", () => {
    const args = buildFireSpawnArgs({
      selectedBackend: "codex",
      initialContent: "",
      launchConfig: { goal: { objective: "fix the bug" } },
    });
    const prefillIndex = args.indexOf("--prefill");
    assert.ok(prefillIndex >= 0);
    assert.equal(args[prefillIndex + 1], "fix the bug");
  });

  it("prefers initialContent (already prefixed by web) over goal.objective", () => {
    const args = buildFireSpawnArgs({
      selectedBackend: "codex",
      initialContent: "/goal new\n\nbody",
      launchConfig: { goal: { objective: "stale-objective" } },
    });
    const prefillIndex = args.indexOf("--prefill");
    assert.equal(args[prefillIndex + 1], "/goal new\n\nbody");
  });

  it("emits just backend + -- when nothing to forward", () => {
    const args = buildFireSpawnArgs({ selectedBackend: "codex", initialContent: "" });
    assert.deepEqual(args, ["--backend", "codex", "--"]);
  });
});

describe("BridgeRunner.dispatchBackendTurn per-message routing", () => {
  it("routes a plain message to runTurn on a goal-capable session", async () => {
    const runGoalCalls = [];
    const runTurnCalls = [];
    const backendSession = makeGoalCapableSession({
      runGoal: async (input) => {
        runGoalCalls.push(input);
        return { text: "goal" };
      },
      runTurn: async (content) => {
        runTurnCalls.push(content);
        return { text: "turn" };
      },
    });
    const runner = buildRunner({ backendSession });
    await runner.dispatchBackendTurn("hello", {});
    assert.equal(runGoalCalls.length, 0);
    assert.equal(runTurnCalls.length, 1);
    assert.equal(runTurnCalls[0], "hello");
  });

  it("routes a /goal message to runGoal on a goal-capable session", async () => {
    const runGoalCalls = [];
    const runTurnCalls = [];
    const backendSession = makeGoalCapableSession({
      runGoal: async (input, options) => {
        runGoalCalls.push({ input, options });
        return { text: "goal-reply", goal: { state: "complete" } };
      },
      runTurn: async (content) => {
        runTurnCalls.push(content);
        return { text: "" };
      },
    });
    const runner = buildRunner({ backendSession });
    const result = await runner.dispatchBackendTurn("/goal ship it", {});
    assert.equal(runGoalCalls.length, 1);
    assert.equal(runTurnCalls.length, 0);
    assert.deepEqual(runGoalCalls[0].input, {
      objective: "ship it",
      source: { type: "manual" },
    });
    assert.equal(result.text, "goal-reply");
    assert.deepEqual(result.metadata.goal, { state: "complete" });
  });

  it("falls back to runTurn for /goal when the session is NOT goal-capable", async () => {
    const runGoalCalls = [];
    const runTurnCalls = [];
    const backendSession = makeNonGoalCapableSession({
      runGoal: async (input) => {
        runGoalCalls.push(input);
        return { text: "ignored" };
      },
      runTurn: async (content) => {
        runTurnCalls.push(content);
        return { text: "turn-reply" };
      },
    });
    const runner = buildRunner({ backendSession });
    const result = await runner.dispatchBackendTurn("/goal ship it", {});
    assert.equal(runGoalCalls.length, 0, "must NOT call runGoal on non-goal-capable session");
    assert.equal(runTurnCalls.length, 1);
    assert.equal(runTurnCalls[0], "/goal ship it", "raw text passed through to runTurn");
    assert.equal(result.text, "turn-reply");
  });

  it("re-dispatches runGoal on a SECOND /goal message in the same session (no marker)", async () => {
    const runGoalCalls = [];
    const runTurnCalls = [];
    const backendSession = makeGoalCapableSession({
      runGoal: async (input) => {
        runGoalCalls.push(input);
        return { text: "goal" };
      },
      runTurn: async (content) => {
        runTurnCalls.push(content);
        return { text: "turn" };
      },
    });
    const runner = buildRunner({ backendSession });

    await runner.dispatchBackendTurn("/goal first", {});
    await runner.dispatchBackendTurn("normal follow up", {});
    await runner.dispatchBackendTurn("/goal another", {});

    assert.equal(runGoalCalls.length, 2, "each /goal message must dispatch runGoal");
    assert.deepEqual(
      runGoalCalls.map((c) => c.objective),
      ["first", "another"],
    );
    assert.equal(runTurnCalls.length, 1);
    assert.equal(runTurnCalls[0], "normal follow up");
  });

  it("treats sessions without getSnapshot as non-goal-capable", async () => {
    const runGoalCalls = [];
    const runTurnCalls = [];
    const backendSession = {
      runGoal: async (input) => {
        runGoalCalls.push(input);
        return { text: "x" };
      },
      runTurn: async (content) => {
        runTurnCalls.push(content);
        return { text: "y" };
      },
    };
    const runner = buildRunner({ backendSession });
    await runner.dispatchBackendTurn("/goal ship it", {});
    assert.equal(runGoalCalls.length, 0);
    assert.equal(runTurnCalls.length, 1);
  });
});

describe("BridgeRunner.dispatchBackendTurn runtime status (aiMode)", () => {
  it("emits aiMode='goal' when routing through runGoal", async () => {
    const statusCalls = [];
    const conductor = buildConductorStub({
      sendRuntimeStatus: async (_taskId, payload) => {
        statusCalls.push(payload);
        return {};
      },
    });
    const backendSession = makeGoalCapableSession({
      runGoal: async () => ({ text: "ok" }),
    });
    const runner = buildRunner({ backendSession, conductor });
    await runner.dispatchBackendTurn("/goal ship", {});

    const goalStatus = statusCalls.find((p) => p && p.aiMode === "goal");
    assert.ok(goalStatus, `expected an aiMode=goal status; got ${JSON.stringify(statusCalls)}`);
  });

  it("emits aiMode='turn' when routing through runTurn", async () => {
    const statusCalls = [];
    const conductor = buildConductorStub({
      sendRuntimeStatus: async (_taskId, payload) => {
        statusCalls.push(payload);
        return {};
      },
    });
    const backendSession = makeGoalCapableSession();
    const runner = buildRunner({ backendSession, conductor });
    await runner.dispatchBackendTurn("just chatting", {});

    const turnStatus = statusCalls.find((p) => p && p.aiMode === "turn");
    assert.ok(turnStatus, `expected an aiMode=turn status; got ${JSON.stringify(statusCalls)}`);
  });

  it("still dispatches runGoal when the runtime-status channel throws", async () => {
    const runGoalCalls = [];
    const conductor = buildConductorStub({
      sendRuntimeStatus: async () => {
        throw new Error("channel boom");
      },
    });
    const backendSession = makeGoalCapableSession({
      runGoal: async (input) => {
        runGoalCalls.push(input);
        return { text: "ok" };
      },
    });
    const runner = buildRunner({ backendSession, conductor });
    const result = await runner.dispatchBackendTurn("/goal ship it", {});
    assert.equal(runGoalCalls.length, 1, "runGoal must still fire even if status emit throws");
    assert.equal(result.text, "ok");
  });

  it("still dispatches runTurn when the runtime-status channel throws", async () => {
    const runTurnCalls = [];
    const conductor = buildConductorStub({
      sendRuntimeStatus: async () => {
        throw new Error("channel boom");
      },
    });
    const backendSession = makeGoalCapableSession({
      runTurn: async (content) => {
        runTurnCalls.push(content);
        return { text: "ok" };
      },
    });
    const runner = buildRunner({ backendSession, conductor });
    const result = await runner.dispatchBackendTurn("hello", {});
    assert.equal(runTurnCalls.length, 1);
    assert.equal(result.text, "ok");
  });
});

describe("BridgeRunner.dispatchBackendTurn result shape", () => {
  it("fills in provider and events on the result when runGoal omits them", async () => {
    const backendSession = makeGoalCapableSession({
      runGoal: async () => ({
        text: "goal-reply",
        usage: { total_tokens: 12 },
        goal: { status: "complete" },
        metadata: { source: "fake-codex" },
      }),
      runTurn: async () => ({ text: "should-not-be-called" }),
    });
    const runner = buildRunner({ backendSession });
    const result = await runner.dispatchBackendTurn("/goal ship it", {});

    assert.equal(result.text, "goal-reply");
    assert.equal(result.provider, "codex", "provider should fall back to backendName");
    assert.ok(Array.isArray(result.events));
    assert.equal(result.events.length, 0);
    assert.deepEqual(result.metadata.goal, { status: "complete" });
    assert.equal(result.metadata.source, "fake-codex");
  });

  it("passes through runGoal's provider/events when present", async () => {
    const backendSession = makeGoalCapableSession({
      runGoal: async () => ({
        text: "ok",
        usage: null,
        goal: { status: "active" },
        provider: "custom-provider",
        events: [{ type: "agent_message", text: "hello" }],
      }),
    });
    const runner = buildRunner({ backendSession });
    const result = await runner.dispatchBackendTurn("/goal ship it", {});

    assert.equal(result.provider, "custom-provider");
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].text, "hello");
  });
});
