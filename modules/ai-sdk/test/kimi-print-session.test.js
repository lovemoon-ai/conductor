import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { KimiPrintSession } from "../src/providers/kimi-print-session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_HEARTBEAT = path.resolve(__dirname, "..", "fixtures", "fake-kimi-print-heartbeat.js");
const FAKE_KIMI_CODE = path.resolve(__dirname, "..", "fixtures", "fake-kimi-code.js");

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
