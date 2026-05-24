import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BridgeRunner,
  GOAL_CAPABLE_BACKENDS,
  assertBackendSupportsGoalsIfRequested,
  clearGoalDispatchedInProcess,
  clearGoalDispatchedMarker,
  hasGoalDispatchedInProcess,
  hasGoalDispatchedMarker,
  parseCliArgs,
  resolveGoalSourceFromEnv,
  resolveInitialGoalPending,
  writeGoalDispatchedMarker,
} from "../bin/conductor-fire.js";
import {
  buildFireSpawnArgs,
  buildFireSpawnGoalEnv,
  isGoalModeLaunchConfig,
} from "../src/daemon.js";

function writeConfig(contents) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-goal-"));
  const configPath = path.join(tempDir, "config.yaml");
  fs.writeFileSync(configPath, contents, "utf8");
  return configPath;
}

const GOAL_ENV_VARS = ["CONDUCTOR_GOAL_SOURCE_TYPE", "CONDUCTOR_GOAL_ISSUE_ID"];

function clearGoalEnv() {
  for (const key of GOAL_ENV_VARS) {
    delete process.env[key];
  }
}

let uniqueTaskCounter = 0;
function uniqueTaskId(prefix = "task-goal") {
  uniqueTaskCounter += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${uniqueTaskCounter}`;
}

const createdGoalMarkers = new Set();

function recordTaskForCleanup(taskId) {
  if (taskId) {
    createdGoalMarkers.add(taskId);
  }
  return taskId;
}

// Isolate the fire goal-marker state dir into a tmpdir so the tests never
// touch the user's homedir or the repo root. Recreated per test for cleanliness.
let testStateDir = "";

beforeEach(() => {
  clearGoalEnv();
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-goal-state-"));
  process.env.CONDUCTOR_FIRE_STATE_DIR = testStateDir;
  // Wipe the module-level in-process backstop set so a previous test can't
  // leak a "dispatched" flag into a fresh test's resolveInitialGoalPending.
  clearGoalDispatchedInProcess();
});

afterEach(() => {
  clearGoalEnv();
  for (const taskId of createdGoalMarkers) {
    try {
      clearGoalDispatchedMarker(taskId);
    } catch {
      // ignore
    }
  }
  createdGoalMarkers.clear();
  clearGoalDispatchedInProcess();
  delete process.env.CONDUCTOR_FIRE_STATE_DIR;
  if (testStateDir) {
    try {
      fs.rmSync(testStateDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    testStateDir = "";
  }
});

describe("daemon buildFireSpawnArgs", () => {
  it("does not append --goal when launch_config is empty", () => {
    const args = buildFireSpawnArgs({
      selectedBackend: "codex",
      initialContent: "hello world",
      launchConfig: {},
    });
    assert.deepEqual(args, ["--backend", "codex", "--prefill", "hello world", "--"]);
    assert.ok(!args.includes("--goal"));
  });

  it("does not append --goal when aiMode is 'turn'", () => {
    const args = buildFireSpawnArgs({
      selectedBackend: "codex",
      initialContent: "hello world",
      launchConfig: { aiMode: "turn" },
    });
    assert.ok(!args.includes("--goal"));
  });

  it("appends --goal when launch_config.aiMode === 'goal'", () => {
    const args = buildFireSpawnArgs({
      selectedBackend: "codex",
      initialContent: "fix the bug",
      launchConfig: {
        aiMode: "goal",
        goal: { objective: "fix the bug", source: "issue" },
      },
    });
    assert.ok(args.includes("--goal"), "expected --goal in spawn args");
    // prefill is still the goal objective string
    const prefillIndex = args.indexOf("--prefill");
    assert.ok(prefillIndex >= 0);
    assert.equal(args[prefillIndex + 1], "fix the bug");
  });

  it("appends --goal when only the goal block is present (no aiMode)", () => {
    const args = buildFireSpawnArgs({
      selectedBackend: "codex",
      initialContent: "",
      launchConfig: { goal: { objective: "ship the feature", source: "manual" } },
    });
    assert.ok(args.includes("--goal"));
    const prefillIndex = args.indexOf("--prefill");
    assert.ok(prefillIndex >= 0);
    assert.equal(args[prefillIndex + 1], "ship the feature");
  });

  it("prefers launch_config.goal.objective over the initialContent prefill", () => {
    const args = buildFireSpawnArgs({
      selectedBackend: "codex",
      initialContent: "stale prefill",
      launchConfig: {
        aiMode: "goal",
        goal: { objective: "fresh objective" },
      },
    });
    const prefillIndex = args.indexOf("--prefill");
    assert.equal(args[prefillIndex + 1], "fresh objective");
  });

  it("falls back to initialContent when goal block has no objective", () => {
    const args = buildFireSpawnArgs({
      selectedBackend: "codex",
      initialContent: "user prompt",
      launchConfig: { aiMode: "goal" },
    });
    const prefillIndex = args.indexOf("--prefill");
    assert.equal(args[prefillIndex + 1], "user prompt");
    assert.ok(args.includes("--goal"));
  });

  it("isGoalModeLaunchConfig handles snake_case ai_mode too", () => {
    assert.equal(isGoalModeLaunchConfig({ ai_mode: "goal" }), true);
    assert.equal(isGoalModeLaunchConfig({ aiMode: "GOAL" }), true);
    assert.equal(isGoalModeLaunchConfig({ aiMode: "turn" }), false);
    assert.equal(isGoalModeLaunchConfig(null), false);
    assert.equal(isGoalModeLaunchConfig(undefined), false);
    assert.equal(isGoalModeLaunchConfig({}), false);
    assert.equal(isGoalModeLaunchConfig({ goal: { objective: "x" } }), true);
    assert.equal(isGoalModeLaunchConfig({ goal: { objective: "" } }), false);
  });
});

describe("daemon buildFireSpawnGoalEnv", () => {
  it("returns {} when launch_config is not goal-mode", () => {
    assert.deepEqual(buildFireSpawnGoalEnv({ launchConfig: {} }), {});
    assert.deepEqual(buildFireSpawnGoalEnv({ launchConfig: { aiMode: "turn" } }), {});
    assert.deepEqual(buildFireSpawnGoalEnv({}), {});
  });

  it("sets CONDUCTOR_GOAL_SOURCE_TYPE=issue and CONDUCTOR_GOAL_ISSUE_ID when source=issue", () => {
    const env = buildFireSpawnGoalEnv({
      launchConfig: {
        aiMode: "goal",
        goal: { objective: "fix it", source: "issue", issueId: "I-7" },
      },
    });
    assert.equal(env.CONDUCTOR_GOAL_SOURCE_TYPE, "issue");
    assert.equal(env.CONDUCTOR_GOAL_ISSUE_ID, "I-7");
  });

  it("supports snake_case issue_id alias", () => {
    const env = buildFireSpawnGoalEnv({
      launchConfig: {
        aiMode: "goal",
        goal: { objective: "fix it", source: "issue", issue_id: "I-99" },
      },
    });
    assert.equal(env.CONDUCTOR_GOAL_SOURCE_TYPE, "issue");
    assert.equal(env.CONDUCTOR_GOAL_ISSUE_ID, "I-99");
  });

  it("sets CONDUCTOR_GOAL_SOURCE_TYPE=manual and omits issueId for manual goals", () => {
    const env = buildFireSpawnGoalEnv({
      launchConfig: {
        aiMode: "goal",
        goal: { objective: "ship the feature", source: "manual" },
      },
    });
    assert.equal(env.CONDUCTOR_GOAL_SOURCE_TYPE, "manual");
    assert.ok(!("CONDUCTOR_GOAL_ISSUE_ID" in env), "issueId env should not be set for manual goals");
  });

  it("defaults source type to manual when omitted or unrecognized", () => {
    assert.equal(
      buildFireSpawnGoalEnv({
        launchConfig: { aiMode: "goal", goal: { objective: "x" } },
      }).CONDUCTOR_GOAL_SOURCE_TYPE,
      "manual",
    );
    assert.equal(
      buildFireSpawnGoalEnv({
        launchConfig: { aiMode: "goal", goal: { objective: "x", source: "bogus" } },
      }).CONDUCTOR_GOAL_SOURCE_TYPE,
      "manual",
    );
  });

  it("handles a 100KB objective without crashing or truncating", () => {
    const bigObjective = "x".repeat(100 * 1024);
    const launchConfig = {
      aiMode: "goal",
      goal: { objective: bigObjective, source: "manual" },
    };
    // Env-builder ignores the objective entirely — it travels via --prefill.
    const env = buildFireSpawnGoalEnv({ launchConfig });
    assert.equal(env.CONDUCTOR_GOAL_SOURCE_TYPE, "manual");
    // Spawn args carry the objective verbatim — assert no truncation.
    const args = buildFireSpawnArgs({
      selectedBackend: "codex",
      initialContent: "",
      launchConfig,
    });
    const prefillIndex = args.indexOf("--prefill");
    assert.ok(prefillIndex >= 0);
    assert.equal(args[prefillIndex + 1].length, bigObjective.length);
    assert.ok(args.includes("--goal"));
  });
});

describe("conductor-fire --goal parsing", () => {
  it("accepts --goal and surfaces goalMode: true on parsed args", async () => {
    const configPath = writeConfig(
      "allow_cli_list:\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n",
    );

    const args = await parseCliArgs([
      "node",
      "conductor-fire",
      "--config-file",
      configPath,
      "--backend",
      "codex",
      "--goal",
      "--",
      "ship",
      "the",
      "feature",
    ]);

    assert.equal(args.goalMode, true);
    assert.equal(args.initialPrompt, "ship the feature");
  });

  it("leaves goalMode false when --goal is not given", async () => {
    const configPath = writeConfig(
      "allow_cli_list:\n  codex: codex --dangerously-bypass-approvals-and-sandbox\n",
    );

    const args = await parseCliArgs([
      "node",
      "conductor-fire",
      "--config-file",
      configPath,
      "--",
      "ship",
      "the",
      "feature",
    ]);

    assert.equal(args.goalMode, false);
  });
});

describe("resolveGoalSourceFromEnv", () => {
  it("defaults to { type: 'manual' } when env is empty", () => {
    assert.deepEqual(resolveGoalSourceFromEnv({}), { type: "manual" });
  });

  it("returns issue source with issueId when env carries both vars", () => {
    assert.deepEqual(
      resolveGoalSourceFromEnv({
        CONDUCTOR_GOAL_SOURCE_TYPE: "issue",
        CONDUCTOR_GOAL_ISSUE_ID: "I-42",
      }),
      { type: "issue", issueId: "I-42" },
    );
  });

  it("returns manual source without issueId even if a stale id env exists", () => {
    assert.deepEqual(
      resolveGoalSourceFromEnv({
        CONDUCTOR_GOAL_SOURCE_TYPE: "manual",
        CONDUCTOR_GOAL_ISSUE_ID: "",
      }),
      { type: "manual" },
    );
  });

  it("falls back to manual for unrecognized source types", () => {
    assert.deepEqual(
      resolveGoalSourceFromEnv({ CONDUCTOR_GOAL_SOURCE_TYPE: "bogus" }),
      { type: "manual" },
    );
  });
});

describe("BridgeRunner goal-mode dispatch", () => {
  function buildRunner({ goalMode, backendSession, taskId }) {
    const resolvedTaskId = taskId || uniqueTaskId();
    recordTaskForCleanup(resolvedTaskId);
    return new BridgeRunner({
      backendSession,
      conductor: {
        sendMessage: async () => ({}),
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        receiveMessages: async () => ({ messages: [] }),
      },
      taskId: resolvedTaskId,
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
      goalMode,
    });
  }

  it("calls runGoal on the first turn when goalMode is on (issue source via env)", async () => {
    process.env.CONDUCTOR_GOAL_SOURCE_TYPE = "issue";
    process.env.CONDUCTOR_GOAL_ISSUE_ID = "I-42";

    const runGoalCalls = [];
    const runTurnCalls = [];
    const backendSession = {
      runGoal: async (input, options) => {
        runGoalCalls.push({ input, options });
        return { text: "goal-reply", usage: null, goal: { state: "complete" } };
      },
      runTurn: async (content, options) => {
        runTurnCalls.push({ content, options });
        return { text: "turn-reply", items: [], usage: null };
      },
    };
    const runner = buildRunner({ goalMode: true, backendSession });

    const result = await runner.dispatchBackendTurn("ship the feature", {});

    assert.equal(runGoalCalls.length, 1);
    assert.equal(runTurnCalls.length, 0);
    assert.equal(runGoalCalls[0].input.objective, "ship the feature");
    assert.deepEqual(runGoalCalls[0].input.source, { type: "issue", issueId: "I-42" });
    assert.equal(result.text, "goal-reply");
    assert.equal(result.metadata.goal.state, "complete");

    // Second turn should go through runTurn.
    await runner.dispatchBackendTurn("follow up", {});
    assert.equal(runGoalCalls.length, 1);
    assert.equal(runTurnCalls.length, 1);
    assert.equal(runTurnCalls[0].content, "follow up");
  });

  it("defaults the goal source to manual when CONDUCTOR_GOAL_SOURCE_TYPE is missing", async () => {
    // env intentionally empty
    const runGoalCalls = [];
    const backendSession = {
      runGoal: async (input) => {
        runGoalCalls.push(input);
        return { text: "ok" };
      },
      runTurn: async () => ({ text: "" }),
    };
    const runner = buildRunner({ goalMode: true, backendSession });
    await runner.dispatchBackendTurn("local cli prompt", {});
    assert.equal(runGoalCalls.length, 1);
    assert.deepEqual(runGoalCalls[0].source, { type: "manual" });
  });

  it("forwards source type manual when env says manual", async () => {
    process.env.CONDUCTOR_GOAL_SOURCE_TYPE = "manual";
    const runGoalCalls = [];
    const backendSession = {
      runGoal: async (input) => {
        runGoalCalls.push(input);
        return { text: "ok" };
      },
      runTurn: async () => ({ text: "" }),
    };
    const runner = buildRunner({ goalMode: true, backendSession });
    await runner.dispatchBackendTurn("ship", {});
    assert.deepEqual(runGoalCalls[0].source, { type: "manual" });
  });

  it("calls runTurn directly when goalMode is off", async () => {
    const runGoalCalls = [];
    const runTurnCalls = [];
    const backendSession = {
      runGoal: async (input) => {
        runGoalCalls.push(input);
        return { text: "x" };
      },
      runTurn: async (content) => {
        runTurnCalls.push(content);
        return { text: "turn-reply" };
      },
    };
    const runner = buildRunner({ goalMode: false, backendSession });

    await runner.dispatchBackendTurn("hi", {});

    assert.equal(runGoalCalls.length, 0);
    assert.equal(runTurnCalls.length, 1);
  });

  it("throws a clear error when goalMode is set but runGoal is missing", async () => {
    const backendSession = {
      runTurn: async () => ({ text: "turn-reply" }),
    };
    const runner = buildRunner({ goalMode: true, backendSession });

    await assert.rejects(
      () => runner.dispatchBackendTurn("ship it", {}),
      /Goal mode requested but the backend session .* does not implement runGoal/,
    );
  });

  it("does not re-dispatch runGoal after a reconnect (marker persists across BridgeRunner instances)", async () => {
    const taskId = recordTaskForCleanup(uniqueTaskId("task-goal-reconnect"));
    // Make sure no stale marker from a previous test run survives.
    clearGoalDispatchedMarker(taskId);

    const runGoalCalls = [];
    const runTurnCalls = [];
    const makeSession = () => ({
      runGoal: async (input, options) => {
        runGoalCalls.push({ input, options });
        return { text: "goal", goal: { state: "complete" } };
      },
      runTurn: async (content) => {
        runTurnCalls.push(content);
        return { text: "turn" };
      },
    });

    // First fire incarnation dispatches the initial goal.
    const runnerA = buildRunner({ goalMode: true, backendSession: makeSession(), taskId });
    assert.equal(runnerA.initialGoalPending, true);
    await runnerA.dispatchBackendTurn("ship the feature", {});
    assert.equal(runGoalCalls.length, 1);
    assert.ok(hasGoalDispatchedMarker(taskId), "marker should be written after runGoal");

    // Simulate a reconnect/daemon restart: a brand-new BridgeRunner with the
    // same taskId and goalMode=true. The next inbound user message MUST go
    // through runTurn — not a second runGoal.
    const runnerB = buildRunner({ goalMode: true, backendSession: makeSession(), taskId });
    assert.equal(runnerB.initialGoalPending, false, "marker should suppress re-dispatch");
    await runnerB.dispatchBackendTurn("follow up after reconnect", {});
    assert.equal(runGoalCalls.length, 1, "runGoal should NOT be called a second time");
    assert.equal(runTurnCalls.length, 1, "the post-reconnect message should hit runTurn");
    assert.equal(runTurnCalls[0], "follow up after reconnect");
  });

  it("treats a brand-new task (no marker) as a fresh goal dispatch", async () => {
    const taskA = recordTaskForCleanup(uniqueTaskId("task-goal-A"));
    const taskB = recordTaskForCleanup(uniqueTaskId("task-goal-B"));
    clearGoalDispatchedMarker(taskA);
    clearGoalDispatchedMarker(taskB);

    const runGoalCalls = [];
    const makeSession = () => ({
      runGoal: async (input) => {
        runGoalCalls.push(input);
        return { text: "ok" };
      },
      runTurn: async () => ({ text: "" }),
    });

    // Fire one task to completion of its initial goal.
    const runnerA = buildRunner({ goalMode: true, backendSession: makeSession(), taskId: taskA });
    await runnerA.dispatchBackendTurn("goal A", {});
    assert.equal(runGoalCalls.length, 1);
    assert.ok(hasGoalDispatchedMarker(taskA));

    // A *different* task (brand new taskId) must NOT inherit task A's marker.
    const runnerB = buildRunner({ goalMode: true, backendSession: makeSession(), taskId: taskB });
    assert.equal(runnerB.initialGoalPending, true, "fresh task should dispatch its own goal");
    await runnerB.dispatchBackendTurn("goal B", {});
    assert.equal(runGoalCalls.length, 2);
  });
});

describe("resolveInitialGoalPending", () => {
  it("returns false when goalMode is off", () => {
    const taskId = recordTaskForCleanup(uniqueTaskId());
    assert.equal(resolveInitialGoalPending({ goalMode: false, taskId }), false);
  });

  it("returns true for a fresh goal task with no marker", () => {
    const taskId = recordTaskForCleanup(uniqueTaskId());
    clearGoalDispatchedMarker(taskId);
    assert.equal(resolveInitialGoalPending({ goalMode: true, taskId }), true);
  });

  it("returns false after the marker is written", () => {
    const taskId = recordTaskForCleanup(uniqueTaskId());
    writeGoalDispatchedMarker(taskId);
    assert.equal(resolveInitialGoalPending({ goalMode: true, taskId }), false);
  });
});

describe("assertBackendSupportsGoalsIfRequested (I4 backend gate)", () => {
  it("returns silently when goalMode is off, regardless of capabilities", async () => {
    const session = {
      getSnapshot: () => ({ capabilities: { goal: false } }),
    };
    await assertBackendSupportsGoalsIfRequested(session, { goalMode: false, backend: "kimi" });
  });

  it("throws a clean error when goalMode is on but capabilities.goal is false", async () => {
    const session = {
      readyPromise: Promise.resolve(),
      getSnapshot: () => ({ capabilities: { goal: false } }),
    };
    await assert.rejects(
      () => assertBackendSupportsGoalsIfRequested(session, { goalMode: true, backend: "kimi" }),
      /Goal mode requested for backend "kimi" which does not support native goals/,
    );
  });

  it("resolves when getSnapshot reports capabilities.goal === true", async () => {
    const session = {
      readyPromise: Promise.resolve(),
      getSnapshot: () => ({ capabilities: { goal: true } }),
    };
    await assertBackendSupportsGoalsIfRequested(session, { goalMode: true, backend: "codex" });
  });

  it("awaits readyPromise before checking the snapshot", async () => {
    const order = [];
    let resolveReady;
    const ready = new Promise((res) => {
      resolveReady = res;
    });
    const session = {
      readyPromise: ready,
      getSnapshot: () => {
        order.push("snapshot");
        return { capabilities: { goal: true } };
      },
    };
    const pending = assertBackendSupportsGoalsIfRequested(session, { goalMode: true, backend: "codex" });
    order.push("queued");
    resolveReady();
    await pending;
    assert.deepEqual(order, ["queued", "snapshot"]);
  });

  it("falls back to runGoal presence when getSnapshot is missing", async () => {
    const session = {
      runGoal: async () => ({ text: "" }),
    };
    await assertBackendSupportsGoalsIfRequested(session, { goalMode: true, backend: "codex" });
  });

  it("throws when neither getSnapshot nor runGoal is available", async () => {
    await assert.rejects(
      () => assertBackendSupportsGoalsIfRequested({}, { goalMode: true, backend: "kimi" }),
      /does not support native goals/,
    );
  });

  it("rejects goal mode for a session whose readyPromise fails", async () => {
    const session = {
      readyPromise: Promise.reject(new Error("transport boom")),
      getSnapshot: () => ({ capabilities: { goal: true } }),
    };
    await assert.rejects(
      () => assertBackendSupportsGoalsIfRequested(session, { goalMode: true, backend: "codex" }),
      /failed to initialize: transport boom/,
    );
  });

  it("exposes the curated GOAL_CAPABLE_BACKENDS list for the early gate", () => {
    assert.ok(Array.isArray(GOAL_CAPABLE_BACKENDS));
    assert.ok(GOAL_CAPABLE_BACKENDS.includes("claude"));
    assert.ok(GOAL_CAPABLE_BACKENDS.includes("codex"));
  });
});

describe("dispatchBackendTurn result shape (N1)", () => {
  function buildRunner({ backendSession, taskId, goalMode = true } = {}) {
    const resolvedTaskId = taskId || uniqueTaskId();
    createdGoalMarkers.add(resolvedTaskId);
    return new BridgeRunner({
      backendSession,
      conductor: {
        sendMessage: async () => ({}),
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        receiveMessages: async () => ({ messages: [] }),
      },
      taskId: resolvedTaskId,
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
      goalMode,
    });
  }

  it("fills in provider and events on the result when runGoal omits them", async () => {
    const backendSession = {
      runGoal: async () => ({
        text: "goal-reply",
        usage: { total_tokens: 12 },
        goal: { status: "complete" },
        metadata: { source: "fake-codex" },
        // intentionally NO `provider`, NO `events`
      }),
      runTurn: async () => ({ text: "should-not-be-called", items: [], usage: null }),
    };
    const runner = buildRunner({ backendSession });
    const result = await runner.dispatchBackendTurn("ship it", {});

    assert.equal(result.text, "goal-reply");
    assert.equal(result.provider, "codex", "provider should fall back to backendName");
    assert.ok(Array.isArray(result.events), "events must be an array");
    assert.equal(result.events.length, 0, "events fallback should be empty array");
    assert.deepEqual(result.metadata.goal, { status: "complete" });
    assert.equal(result.metadata.source, "fake-codex");
  });

  it("passes through runGoal's provider/events when present", async () => {
    const backendSession = {
      runGoal: async () => ({
        text: "ok",
        usage: null,
        goal: { status: "active" },
        provider: "custom-provider",
        events: [{ type: "agent_message", text: "hello" }],
      }),
      runTurn: async () => ({ text: "", items: [], usage: null }),
    };
    const runner = buildRunner({ backendSession });
    const result = await runner.dispatchBackendTurn("ship it", {});

    assert.equal(result.provider, "custom-provider");
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].text, "hello");
  });
});

describe("writeGoalDispatchedMarker structured result (N2)", () => {
  it("returns { persisted: true } and writes a valid JSON file when the write succeeds", () => {
    const taskId = recordTaskForCleanup(uniqueTaskId("task-marker-ok"));
    const result = writeGoalDispatchedMarker(taskId);
    assert.equal(result.persisted, true);
    assert.ok(result.markerPath, "markerPath should be set");
    assert.ok(fs.existsSync(result.markerPath), "marker file should exist on disk");
    const raw = fs.readFileSync(result.markerPath, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.source, "conductor-fire");
    assert.equal(parsed.taskId, taskId);
  });

  it("returns { persisted: false } and emits a warning when the dir cannot be created (N2)", () => {
    const taskId = uniqueTaskId("task-marker-fail");
    // /dev/null can't be a directory parent, so mkdirSync will fail.
    // Use a path under /dev/null/state which is guaranteed to be invalid.
    const badStateDir = "/dev/null/state-cannot-exist";
    process.env.CONDUCTOR_FIRE_STATE_DIR = badStateDir;

    // Capture warnings emitted on stdout (the file uses `log()`).
    const originalWrite = process.stdout.write.bind(process.stdout);
    const captured = [];
    process.stdout.write = (chunk, ...rest) => {
      try {
        captured.push(String(chunk));
      } catch {
        // ignore
      }
      return originalWrite(chunk, ...rest);
    };

    let result;
    try {
      result = writeGoalDispatchedMarker(taskId);
    } finally {
      process.stdout.write = originalWrite;
      // Restore to the test's isolated dir so afterEach can clean up.
      process.env.CONDUCTOR_FIRE_STATE_DIR = testStateDir;
    }

    assert.equal(result.persisted, false, "persisted should be false when write fails");
    const warned = captured.some(
      (line) => line.includes("goal-dispatched marker write failed") && line.includes(taskId),
    );
    assert.ok(warned, `expected warning to mention failure + taskId, captured: ${captured.join("|")}`);
  });

  it("records process.cwd() as the marker cwd field rather than os.homedir() (N4)", () => {
    const taskId = recordTaskForCleanup(uniqueTaskId("task-marker-cwd"));
    const fakeCwd = path.join(testStateDir, "fake-task-cwd");
    fs.mkdirSync(fakeCwd, { recursive: true });
    const result = writeGoalDispatchedMarker(taskId, undefined, fakeCwd);
    assert.equal(result.persisted, true);
    const parsed = JSON.parse(fs.readFileSync(result.markerPath, "utf8"));
    assert.equal(parsed.cwd, path.resolve(fakeCwd), "cwd field must reflect the actual task cwd");
    assert.notEqual(parsed.cwd, os.homedir(), "must NOT default to homedir when taskCwd is passed");
  });

  it("omits the cwd field entirely when no taskCwd is passed (avoids misleading os.homedir() default)", () => {
    const taskId = recordTaskForCleanup(uniqueTaskId("task-marker-no-cwd"));
    const result = writeGoalDispatchedMarker(taskId);
    assert.equal(result.persisted, true);
    const parsed = JSON.parse(fs.readFileSync(result.markerPath, "utf8"));
    assert.ok(
      !("cwd" in parsed),
      "marker should omit cwd when none was supplied, rather than recording a misleading default",
    );
  });
});

describe("BridgeRunner in-process goal-dispatched backstop (N2)", () => {
  function buildRunner({ taskId, backendSession }) {
    return new BridgeRunner({
      backendSession,
      conductor: {
        sendMessage: async () => ({}),
        sendRuntimeStatus: async () => ({}),
        ackMessages: async () => ({}),
        receiveMessages: async () => ({ messages: [] }),
      },
      taskId,
      pollIntervalMs: 500,
      initialPrompt: "",
      includeInitialImages: false,
      cliArgs: [],
      backendName: "codex",
      goalMode: true,
    });
  }

  it("flips goalDispatchedInThisProcess and the module-level set after a successful dispatch", async () => {
    const taskId = recordTaskForCleanup(uniqueTaskId("task-goal-in-proc-flag"));
    const backendSession = {
      runGoal: async () => ({ text: "ok", goal: { status: "complete" } }),
      runTurn: async () => ({ text: "" }),
    };
    const runner = buildRunner({ taskId, backendSession });
    assert.equal(runner.goalDispatchedInThisProcess, false);
    assert.equal(hasGoalDispatchedInProcess(taskId), false);
    await runner.dispatchBackendTurn("go", {});
    assert.equal(runner.goalDispatchedInThisProcess, true);
    assert.equal(hasGoalDispatchedInProcess(taskId), true);
  });

  it("suppresses re-dispatch in a SAME-process reconnect even when the disk marker is missing", async () => {
    const taskId = recordTaskForCleanup(uniqueTaskId("task-goal-in-proc-resume"));
    // Pretend the disk write failed by clearing the marker after the first
    // dispatch. The module-level in-process flag must still be respected.
    const backendSession = () => ({
      runGoal: async () => ({ text: "ok", goal: { status: "complete" } }),
      runTurn: async () => ({ text: "follow-up" }),
    });
    const runnerA = buildRunner({ taskId, backendSession: backendSession() });
    await runnerA.dispatchBackendTurn("first goal", {});

    // Wipe the disk marker so only the in-process flag remains.
    clearGoalDispatchedMarker(taskId);
    assert.equal(hasGoalDispatchedMarker(taskId), false, "marker should be gone");
    assert.equal(hasGoalDispatchedInProcess(taskId), true, "in-process flag must persist");

    const runnerB = buildRunner({ taskId, backendSession: backendSession() });
    assert.equal(runnerB.initialGoalPending, false, "in-process flag must suppress re-dispatch");
  });
});

describe("e2e: marker reconnect via runTurn after first runGoal (test gap)", () => {
  it("second BridgeRunner for the same task routes to runTurn, never runGoal", async () => {
    const taskId = recordTaskForCleanup(uniqueTaskId("task-goal-e2e"));
    clearGoalDispatchedMarker(taskId);

    const runGoalCalls = [];
    const runTurnCalls = [];
    const makeSession = () => ({
      runGoal: async (input) => {
        runGoalCalls.push(input);
        return { text: "goal-reply", goal: { status: "complete" } };
      },
      runTurn: async (content) => {
        runTurnCalls.push(content);
        return { text: "turn-reply", items: [], usage: null };
      },
    });

    const buildRunner = (backendSession) =>
      new BridgeRunner({
        backendSession,
        conductor: {
          sendMessage: async () => ({}),
          sendRuntimeStatus: async () => ({}),
          ackMessages: async () => ({}),
          receiveMessages: async () => ({ messages: [] }),
        },
        taskId,
        pollIntervalMs: 500,
        initialPrompt: "",
        includeInitialImages: false,
        cliArgs: [],
        backendName: "codex",
        goalMode: true,
      });

    const runnerA = buildRunner(makeSession());
    assert.equal(runnerA.initialGoalPending, true);
    await runnerA.dispatchBackendTurn("first turn (goal)", {});

    // Clear the in-process flag to simulate a different process picking up,
    // forcing the disk-marker path to be exercised end-to-end.
    clearGoalDispatchedInProcess(taskId);
    assert.ok(hasGoalDispatchedMarker(taskId), "disk marker must exist for cross-process resume");

    const runnerB = buildRunner(makeSession());
    assert.equal(
      runnerB.initialGoalPending,
      false,
      "second runner must see marker and NOT mark turn as goal-pending",
    );
    await runnerB.dispatchBackendTurn("follow-up after reconnect", {});

    assert.equal(runGoalCalls.length, 1, "runGoal should only fire on the first runner");
    assert.equal(runTurnCalls.length, 1, "the post-reconnect turn must use runTurn");
    assert.equal(runTurnCalls[0], "follow-up after reconnect");
  });
});

describe("writeGoalDispatchedMarker concurrent writes (test gap)", () => {
  it("two parallel writes for the same task produce a valid JSON marker with no exception", async () => {
    const taskId = recordTaskForCleanup(uniqueTaskId("task-marker-concurrent"));
    const results = await Promise.all([
      Promise.resolve().then(() => writeGoalDispatchedMarker(taskId)),
      Promise.resolve().then(() => writeGoalDispatchedMarker(taskId)),
    ]);
    assert.equal(results[0].persisted, true);
    assert.equal(results[1].persisted, true);
    assert.ok(fs.existsSync(results[0].markerPath));
    // File contents should be valid JSON regardless of which write won.
    const raw = fs.readFileSync(results[0].markerPath, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.taskId, taskId);
    assert.equal(parsed.source, "conductor-fire");
  });
});

describe("hasGoalDispatchedMarker with corrupted file (test gap)", () => {
  it("returns true when the marker exists but contains garbage (existence-only semantics)", () => {
    const taskId = recordTaskForCleanup(uniqueTaskId("task-marker-garbage"));
    // First write the marker normally to get its canonical path.
    const { markerPath } = writeGoalDispatchedMarker(taskId);
    assert.ok(markerPath);
    // Overwrite with garbage; existsSync should still report true.
    fs.writeFileSync(markerPath, "not-json-at-all-{{{", "utf8");
    assert.equal(
      hasGoalDispatchedMarker(taskId),
      true,
      "behavior is locked in: existence is enough; corruption is treated as 'dispatched' (safe default — would NOT re-fire runGoal)",
    );
  });
});
