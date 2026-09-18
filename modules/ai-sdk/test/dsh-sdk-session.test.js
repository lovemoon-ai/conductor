import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DshSdkSession } from "../src/session-factory.js";
import { COMPACT_SUMMARY_PROMPT } from "../src/providers/dsh-sdk-session.js";
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
  it("clears the compacting status once automatic compaction ends", async () => {
    const session = createSession();
    const statuses = [];
    session.on("working_status", (payload) => statuses.push(payload));
    try {
      await session.runTurn("work [auto-compact]");
      const compactingIndex = statuses.findIndex((payload) => payload.phase === "context_compaction");
      assert.ok(compactingIndex >= 0);
      assert.equal(statuses[compactingIndex + 1].status_line, "dsh is working");
    } finally {
      await session.close();
    }
  });

  it("runCompact summarizes silently and continues on a fresh session seeded with the summary", async () => {
    const session = createSession();
    const assistantMessages = [];
    session.on("assistant_message", (payload) => assistantMessages.push(payload.text));

    try {
      assert.equal(session.getSnapshot().capabilities.compact, true);
      const empty = await session.runCompact({});
      assert.deepEqual(empty.compact, { status: "noop", instructionsApplied: false });

      await session.runTurn("hello dsh");
      const firstSessionId = session.getSnapshot().sessionId;
      const result = await session.runCompact({ instructions: "keep the file list" });

      assert.deepEqual(result.compact, { status: "compacted", instructionsApplied: true });
      // The id only rotates on the next turn, once the new session gets a log.
      assert.equal(session.getSessionInfo().sessionId, firstSessionId);
      assert.equal(session.history.length, 1);
      assert.match(session.history[0].content, /^Summary of the conversation so far:/);
      assert.match(session.history[0].content, /Additional focus: keep the file list/);
      assert.deepEqual(assistantMessages, ["echo:hello dsh"]);

      // The next turn runs on the new session with the summary as its seed.
      const next = await session.runTurn("continue");
      assert.notEqual(session.getSnapshot().sessionId, firstSessionId);
      assert.match(next.text, /Continue the existing conversation with this history\./);
      assert.match(next.text, /Summary of the conversation so far:/);
      assert.doesNotMatch(next.text, /User: hello dsh/);
    } finally {
      await session.close();
    }
  });

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

  it("restores only the compaction summary and later turns when resuming after /compact", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-compact-resume-"));
    const oldSessionId = "session-compacted42";
    const sessionDir = path.join(root, "--proj--", oldSessionId);
    await fsp.mkdir(sessionDir, { recursive: true });
    const user = (seq, text) => ({
      type: "user/message",
      seq,
      time: seq,
      data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text }] },
    });
    const assistant = (seq, text) => ({
      type: "assistant/message",
      seq,
      time: seq,
      data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text }] } },
    });
    const lines = [
      { type: "session", version: 1, id: oldSessionId, createdAt: 1, cwd: process.cwd(), delegationDepth: 0 },
      user(1, "earlier-user-question"),
      assistant(2, "earlier-assistant-reply"),
      user(3, `${COMPACT_SUMMARY_PROMPT}\n\nAdditional focus: keep ids`),
      assistant(4, "the-compact-summary"),
      user(5, "later-user-question"),
      assistant(6, "later-assistant-reply"),
    ];
    await fsp.writeFile(
      path.join(sessionDir, "session.jsonl"),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    const session = createSession({ resumeSessionId: oldSessionId, dshSessionRoot: root });
    try {
      const result = await session.runTurn("hi again");
      assert.match(result.text, /Summary of the conversation so far:\n\nthe-compact-summary/);
      assert.match(result.text, /later-user-question/);
      assert.doesNotMatch(result.text, /earlier-user-question/);
      assert.doesNotMatch(result.text, /Reply with the summary only/);
    } finally {
      await session.close();
    }
  });

  it("keeps the full history on resume when a /compact turn failed or never finished", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-compact-failed-"));
    const user = (seq, text) => ({
      type: "user/message",
      seq,
      data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text }] },
    });
    const assistant = (seq, text) => ({
      type: "assistant/message",
      seq,
      data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text }] } },
    });
    const writeLog = async (sessionId, events) => {
      const dir = path.join(root, "--proj--", sessionId);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "session.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
    };
    await writeLog("session-failed", [
      user(1, "q1"),
      assistant(2, "r1"),
      user(3, COMPACT_SUMMARY_PROMPT),
      { type: "turn/end", seq: 4, data: { turn: 2, reason: { kind: "error", error: { message: "boom" } } } },
      user(5, "q2"),
      assistant(6, "r2"),
    ]);
    await writeLog("session-cut", [user(1, "q1"), assistant(2, "r1"), user(3, COMPACT_SUMMARY_PROMPT)]);

    const session = createSession({ dshSessionRoot: root });
    try {
      assert.deepEqual(session.loadPersistedHistory("session-failed"), [
        { role: "user", content: "q1" },
        { role: "assistant", content: "r1" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "r2" },
      ]);
      assert.deepEqual(session.loadPersistedHistory("session-cut"), [
        { role: "user", content: "q1" },
        { role: "assistant", content: "r1" },
      ]);
    } finally {
      await session.close();
    }
  });

  it("runCompact is a noop when the session to resume has no persisted log", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-compact-missing-"));
    const session = createSession({ resumeSessionId: "session-gone", dshSessionRoot: root });
    try {
      const result = await session.runCompact({});
      assert.deepEqual(result.compact, { status: "noop", instructionsApplied: false });
      assert.deepEqual(session.history, []);
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
