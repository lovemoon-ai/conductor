import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DshSdkSession } from "../src/session-factory.js";
import {
  DSH_SDK_VARIANT,
  getBuiltInBackendEntry,
  normalizeBuiltInBackend,
} from "../src/built-in-backends.js";
import { providerVariantForBackend } from "../src/session-factory.js";
import {
  buildResumeArgsForBackend,
  findSessionPath,
  resolveResumeContext,
} from "../src/resume/index.js";

const FAKE_RUNTIME_PATH = fileURLToPath(new URL("../fixtures/fake-dsh-runtime.js", import.meta.url));

function createSession(options = {}) {
  return new DshSdkSession("dsh", {
    cwd: process.cwd(),
    logger: { log: () => {} },
    dshRuntimeCommand: process.execPath,
    dshRuntimeArgs: [FAKE_RUNTIME_PATH],
    ...options,
  });
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor timed out");
}

describe("dsh backend registry", () => {
  it("registers dsh as a built-in backend with the dsh-sdk variant", async () => {
    assert.equal(normalizeBuiltInBackend("dsh"), "dsh");
    assert.equal(normalizeBuiltInBackend("deepseek-harness"), "dsh");
    assert.equal(getBuiltInBackendEntry("dsh")?.defaultVariant, DSH_SDK_VARIANT);
    assert.equal(await providerVariantForBackend("dsh"), DSH_SDK_VARIANT);
  });
});

describe("dsh sdk session", () => {
  it("runs one echo turn end to end against the fake runtime", async () => {
    const session = createSession();
    const assistantMessages = [];
    const workingPhases = [];
    let sessionEventPayload = null;
    session.on("assistant_message", (payload) => assistantMessages.push(payload));
    session.on("working_status", (payload) => workingPhases.push(payload.phase));
    session.on("session", (payload) => {
      sessionEventPayload = payload;
    });

    try {
      const result = await session.runTurn("hello dsh");

      assert.equal(result.text, "echo:hello dsh");
      assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 5 });
      assert.equal(result.provider, "dsh");
      assert.equal(result.metadata.source, DSH_SDK_VARIANT);
      assert.equal(result.metadata.sessionId, session.getSnapshot().sessionId);
      assert.equal(result.metadata.turnEndReason.kind, "completed");

      assert.equal(assistantMessages.length, 1);
      assert.equal(assistantMessages[0].text, "echo:hello dsh");
      // Token-level chunks must be filtered out of the returned items.
      assert.ok(result.items.length > 0);
      assert.ok(
        !result.items.some((item) => item?.params?.event?.type === "assistant/chunk"),
        "assistant/chunk notifications must not surface in result.items",
      );
      assert.ok(workingPhases.includes("turn_started"));
      assert.ok(workingPhases.includes("message_aggregation"));
      assert.ok(workingPhases.includes("turn_completed"));
      assert.equal(sessionEventPayload?.sessionId, session.getSnapshot().sessionId);

      const usageSummary = await session.getSessionUsageSummary();
      assert.deepEqual(usageSummary.usage, { inputTokens: 3, outputTokens: 5 });
    } finally {
      await session.close();
    }
  });

  it("keeps one runtime process across turns and accumulates usage", async () => {
    const session = createSession();
    try {
      await session.runTurn("first");
      const second = await session.runTurn("second");
      assert.equal(second.text, "echo:second");
      const usageSummary = await session.getSessionUsageSummary();
      assert.deepEqual(usageSummary.usage, { inputTokens: 6, outputTokens: 10 });
    } finally {
      await session.close();
    }
  });

  it("resumes by seeding persisted history into a fresh wire session", async () => {
    // The dsh SDK runtime cannot prompt an id whose JSONL log already exists
    // (id collision), so resume mints a fresh wire id and seeds the restored
    // conversation into the first prompt.
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-resume-root-"));
    const oldSessionId = "session-resume42";
    const sessionDir = path.join(root, "--proj--", oldSessionId);
    await fsp.mkdir(sessionDir, { recursive: true });
    const lines = [
      { type: "session", version: 1, id: oldSessionId, createdAt: 1, cwd: process.cwd(), delegationDepth: 0 },
      {
        type: "user/message",
        seq: 1,
        time: 1,
        data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "earlier-user-question" }] },
      },
      {
        type: "assistant/message",
        seq: 2,
        time: 2,
        data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "earlier-assistant-reply" }] } },
      },
    ];
    await fsp.writeFile(
      path.join(sessionDir, "session.jsonl"),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    const session = createSession({ resumeSessionId: oldSessionId, dshSessionRoot: root });
    try {
      const wireSessionId = session.getSnapshot().sessionId;
      assert.notEqual(wireSessionId, oldSessionId);
      assert.match(wireSessionId, /^session-/);
      const result = await session.runTurn("hi again");
      // The fake runtime echoes the full prompt, which must carry the seed.
      assert.match(result.text, /earlier-user-question/);
      assert.match(result.text, /earlier-assistant-reply/);
      assert.match(result.text, /hi again/);
    } finally {
      await session.close();
    }
  });

  it("translates tool calls and todo writes into working statuses", async () => {
    const session = createSession();
    const statuses = [];
    session.on("working_status", (payload) => statuses.push(payload));
    try {
      await session.runTurn("[tool] run ls");
      const commandStatus = statuses.find((status) => status.phase === "command_execution");
      assert.ok(commandStatus, "expected a command_execution status for the bash tool call");
      assert.match(commandStatus.status_line, /dsh running command/);
      assert.match(commandStatus.status_line, /ls/);
      const todoStatus = statuses.find((status) => status.phase === "task_progress");
      assert.ok(todoStatus, "expected a task_progress status for the todo write");
      assert.match(todoStatus.status_line, /1\/1/);
    } finally {
      await session.close();
    }
  });

  it("fails the turn with the runtime's error detail and emits auth_required for credential errors", async () => {
    const session = createSession();
    const authEvents = [];
    session.on("auth_required", (payload) => authEvents.push(payload));
    try {
      await assert.rejects(
        () => session.runTurn("[fail-turn]"),
        (error) =>
          error.reason === "turn_failed" &&
          /fake api key rejected/.test(error.message),
      );
      assert.equal(authEvents.length, 1);
      assert.match(authEvents[0].message, /fake api key rejected/);
    } finally {
      await session.close();
    }
  });

  it("interrupts a hanging turn by tearing down the runtime, then resumes the same session", async () => {
    const session = createSession();
    const statuses = [];
    session.on("working_status", (payload) => statuses.push(payload));
    try {
      const turnPromise = session.runTurn("[hang]").then(
        () => {
          throw new Error("hanging turn should not complete");
        },
        (error) => error,
      );

      // The first turn_started is emitted locally before the runtime spawns;
      // the second one is driven by the runtime's `running` status, so the
      // prompt is on the wire (and the session id burned) once it appears.
      await waitFor(() => statuses.filter((status) => status.phase === "turn_started").length >= 2);
      assert.equal(await session.interruptCurrentTurn(), true);

      const turnError = await turnPromise;
      assert.equal(turnError.reason, "turn_interrupted");

      // The next turn respawns a fresh runtime on a ROTATED session id (the
      // old id's persisted log would collide) and carries the history seed.
      const interruptedSessionId = session.getSnapshot().sessionId;
      const result = await session.runTurn("[echo-session]");
      const rotatedSessionId = session.getSnapshot().sessionId;
      assert.notEqual(rotatedSessionId, interruptedSessionId);
      assert.equal(result.text, rotatedSessionId);
    } finally {
      await session.close();
    }
  });

  it("returns an empty result for an empty prompt without spawning a runtime", async () => {
    const session = createSession({ dshRuntimeCommand: "/nonexistent-runtime" });
    try {
      const result = await session.runTurn("   ");
      assert.equal(result.text, "");
      assert.equal(session.harness, null);
    } finally {
      await session.close();
    }
  });

  it("rejects further turns after close", async () => {
    const session = createSession();
    await session.close();
    await assert.rejects(() => session.runTurn("hello"), /session closed/);
  });

  it("derives model and provider overrides from the allow_cli_list command line", () => {
    const session = createSession({
      commandLine: "dsh --model deepseek-v4 --provider my-route",
    });
    assert.equal(session.model, "deepseek-v4");
    assert.equal(session.dshProvider, "my-route");
  });
});

describe("dsh resume module", () => {
  it("builds inert resume args", () => {
    assert.deepEqual(buildResumeArgsForBackend("dsh", "session-abc"), [
      "--resume-session-id=session-abc",
    ]);
  });

  it("finds the session log and recovers cwd from the header line", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-sessions-"));
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-workspace-"));
    const sessionId = "session-feedbeef";
    const sessionDir = path.join(root, "--tmp-workspace--", sessionId);
    await fsp.mkdir(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, "session.jsonl");
    const header = { type: "session", version: 1, id: sessionId, createdAt: 1, cwd, delegationDepth: 0 };
    await fsp.writeFile(sessionPath, `${JSON.stringify(header)}\n`, "utf8");

    assert.equal(await findSessionPath("dsh", sessionId, { dshSessionRoot: root }), sessionPath);

    const context = await resolveResumeContext("dsh", sessionId, { dshSessionRoot: root });
    assert.equal(context.provider, "dsh");
    assert.equal(context.sessionId, sessionId);
    assert.equal(context.sessionPath, sessionPath);
    assert.equal(context.cwd, cwd);
    assert.equal(context.debugMetadata.cwdSource, "session");
  });

  it("rejects an unknown dsh session id", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-sessions-empty-"));
    await assert.rejects(
      () => resolveResumeContext("dsh", "session-missing", { dshSessionRoot: root }),
      /Invalid --resume session id for dsh/,
    );
  });
});
