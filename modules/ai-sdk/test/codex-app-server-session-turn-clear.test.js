import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexAppServerSession } from "../src/providers/codex-app-server-session.js";

function makeSession() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-turn-clear-"));
  const session = new CodexAppServerSession("codex", {
    cwd,
    logger: { log: () => {} },
  });
  const statuses = [];
  session.on("working_status", (snapshot) => statuses.push(snapshot));
  return { session, statuses };
}

function installActiveTurn(session, { turnId = "" } = {}) {
  let resolved = null;
  const currentTurn = {
    turnId,
    fullText: "hi there",
    activeAssistantMessageId: "",
    activeAssistantMessageText: "",
    resolve: (value) => {
      resolved = value ?? true;
    },
    reject: () => {},
  };
  session.currentTurn = currentTurn;
  return {
    currentTurn,
    wasResolved: () => resolved !== null,
  };
}

describe("codex app-server session - terminal status clear (P2)", () => {
  it("clears the composer even when turn/completed fails turn matching (non-goal)", async () => {
    const { session, statuses } = makeSession();
    // Bind a turnId that will NOT match the incoming turn/completed id, forcing
    // ensureCurrentTurn() to return null in non-goal mode.
    const turn = installActiveTurn(session, { turnId: "turn-A" });

    await session.handleNotification("turn/completed", {
      turnId: "turn-B",
      turn: { id: "turn-B", status: "completed", error: null },
    });

    const cleared = statuses.filter((s) => s.reply_in_progress === false);
    assert.ok(
      cleared.length >= 1,
      `expected a reply_in_progress:false clear, got ${JSON.stringify(statuses)}`,
    );
    assert.equal(cleared.at(-1).status_done_line, "codex finished");
    assert.equal(turn.wasResolved(), true, "the active turn must resolve");
    assert.equal(session.currentTurn, null, "currentTurn must be released");
  });

  it("emits the terminal clear exactly once (idempotent)", async () => {
    const { session, statuses } = makeSession();
    const { currentTurn } = installActiveTurn(session, { turnId: "" });

    await session.emitTurnCompletedStatus(currentTurn);
    await session.emitTurnCompletedStatus(currentTurn);
    await session.emitTurnCompletedStatus(currentTurn, {
      phase: "turn_failed",
      status_done_line: "codex failed (x)",
    });

    const cleared = statuses.filter((s) => s.reply_in_progress === false);
    assert.equal(cleared.length, 1, `expected exactly one clear, got ${cleared.length}`);
    assert.equal(cleared[0].status_done_line, "codex finished");
    assert.equal(currentTurn.terminalStatusEmitted, true);
  });

  it("does not clear when there is no active turn", async () => {
    const { session, statuses } = makeSession();
    session.currentTurn = null;

    await session.handleNotification("turn/completed", {
      turnId: "turn-Z",
      turn: { id: "turn-Z", status: "completed", error: null },
    });

    assert.equal(
      statuses.filter((s) => s.reply_in_progress === false).length,
      0,
      "no spurious clear should be emitted without an active turn",
    );
  });
});
