import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { KimiPrintSession } from "../src/providers/kimi-print-session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_HEARTBEAT = path.resolve(__dirname, "..", "fixtures", "fake-kimi-print-heartbeat.js");
const FAKE_KIMI_CODE = path.resolve(__dirname, "..", "fixtures", "fake-kimi-code.js");
const FAKE_KIMI_PRINT = path.resolve(__dirname, "..", "fixtures", "fake-kimi-print.js");

const createSession = (commandLine) =>
  new KimiPrintSession("kimi", {
    cwd: process.cwd(),
    kimiCliMode: "prompt",
    commandLine,
    logger: { log: () => {} },
  });

test("busy turn with steady output is not killed by the turn deadline", async () => {
  const session = createSession(`${process.execPath} ${FAKE_HEARTBEAT}`);
  // The fake emits activity every 150ms for ~1.5s — far beyond this deadline.
  session.turnDeadlineMs = 400;

  const result = await session.runTurn("work");

  assert.ok(result.text.includes("heartbeat 10/10"));
  await session.close();
});

test("silent turn still times out with turn_timeout", async () => {
  const session = createSession(`${process.execPath} ${FAKE_KIMI_CODE}`);
  session.turnDeadlineMs = 400;

  await assert.rejects(session.runTurn("wait [slow]"), (error) => {
    assert.equal(error?.reason, "turn_timeout");
    return true;
  });
  await session.close();
});

test("legacy print runCompact runs the built-in /compact command without surfacing its reply", async () => {
  const session = new KimiPrintSession("kimi", {
    cwd: process.cwd(),
    commandLine: `${process.execPath} ${FAKE_KIMI_PRINT}`,
    logger: { log: () => {} },
  });
  const messages = [];
  session.setSessionMessageHandler(async (payload) => {
    messages.push(payload);
  });

  assert.equal(session.getSnapshot().capabilities.compact, true);
  const compacted = await session.runCompact({ instructions: "ignored" });
  assert.deepEqual(compacted.compact, { status: "compacted", instructionsApplied: false });

  process.env.FAKE_KIMI_PRINT_EMPTY_CONTEXT = "1";
  try {
    const empty = await session.runCompact({});
    assert.deepEqual(empty.compact, { status: "noop", instructionsApplied: false });
  } finally {
    delete process.env.FAKE_KIMI_PRINT_EMPTY_CONTEXT;
  }

  process.env.FAKE_KIMI_PRINT_COMPACT_ERROR = "1";
  try {
    await assert.rejects(session.runCompact({}), (error) => error.reason === "compact_failed");
  } finally {
    delete process.env.FAKE_KIMI_PRINT_COMPACT_ERROR;
  }

  assert.equal(messages.length, 0);
  assert.deepEqual(session.history, []);
  await session.close();
});

test("prompt mode does not advertise compact", async () => {
  const session = createSession(`${process.execPath} ${FAKE_KIMI_CODE}`);
  assert.equal(session.getSnapshot().capabilities.compact, false);
  await session.close();
});

test("legacy print runClear runs the built-in /clear command without surfacing its reply", async () => {
  const session = new KimiPrintSession("kimi", {
    cwd: process.cwd(),
    commandLine: `${process.execPath} ${FAKE_KIMI_PRINT}`,
    logger: { log: () => {} },
  });
  const messages = [];
  session.setSessionMessageHandler(async (payload) => {
    messages.push(payload);
  });

  assert.equal(session.getSnapshot().capabilities.clear, true);
  await session.runTurn("Reply with exactly OK");
  const sessionIdBefore = session.getSessionInfo()?.sessionId;

  const cleared = await session.runClear();

  assert.equal(cleared.clear.status, "cleared");
  // The CLI clears its own context file; the --session id is unchanged.
  assert.equal(cleared.clear.sessionId, sessionIdBefore);
  assert.deepEqual(session.history, []);

  process.env.FAKE_KIMI_PRINT_CLEAR_ERROR = "1";
  try {
    await assert.rejects(session.runClear(), (error) => error.reason === "clear_failed");
  } finally {
    delete process.env.FAKE_KIMI_PRINT_CLEAR_ERROR;
  }

  // Only the real turn surfaced replies; neither clear leaked its CLI answer.
  assert.ok(!messages.some((payload) => /cleared/i.test(payload.text)));
  assert.ok(!messages.some((payload) => /rate limited/i.test(payload.text)));
  await session.close();
});

test("kimi prompt mode advertises no clear support", () => {
  const session = new KimiPrintSession("kimi", {
    cwd: process.cwd(),
    commandLine: `${process.execPath} ${FAKE_KIMI_PRINT}`,
    kimiCliMode: "prompt",
    logger: { log: () => {} },
  });

  assert.equal(session.getSnapshot().capabilities.clear, false);
});
