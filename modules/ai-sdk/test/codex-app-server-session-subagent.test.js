import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexAppServerSession } from "../src/providers/codex-app-server-session.js";

const MAIN = "thread-main";
const SUB = "thread-sub";

function makeSession() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-subagent-"));
  const session = new CodexAppServerSession("codex", { cwd, logger: { log: () => {} } });
  session.sessionId = MAIN;
  const messages = [];
  session.on("assistant_message", (payload) => messages.push(payload.text));
  let resolved = false;
  session.currentTurn = {
    turnId: "",
    fullText: "",
    activeAssistantMessageId: "",
    activeAssistantMessageText: "",
    resolve: () => {
      resolved = true;
    },
    reject: () => {},
  };
  return { session, messages, wasResolved: () => resolved };
}

const delta = (threadId, turnId, itemId, text) => ({ threadId, turnId, itemId, delta: text });

describe("codex app-server session - spawned sub-agent threads", () => {
  it("does not let a sub-agent's turn/completed end the parent turn (task 10c1492f)", async () => {
    const { session, messages, wasResolved } = makeSession();

    await session.handleNotification("turn/started", { threadId: MAIN, turn: { id: "turn-main" } });
    await session.handleNotification("item/agentMessage/delta", delta(MAIN, "turn-main", "m1", "main commentary"));

    // spawn_agent: the sub-agent's thread streams over the same connection.
    await session.handleNotification("thread/started", { thread: { id: SUB, parentThreadId: MAIN } });
    await session.handleNotification("turn/started", { threadId: SUB, turn: { id: "turn-sub" } });
    await session.handleNotification("item/agentMessage/delta", delta(SUB, "turn-sub", "s1", "sub report"));
    await session.handleNotification("turn/completed", {
      threadId: SUB,
      turn: { id: "turn-sub", status: "completed", error: null },
    });

    assert.equal(session.sessionId, MAIN, "sub-agent thread must not replace the session thread");
    assert.equal(wasResolved(), false, "sub-agent completion must not resolve the parent turn");
    assert.ok(session.currentTurn, "parent turn must stay active");

    await session.handleNotification("item/agentMessage/delta", delta(MAIN, "turn-main", "m2", "main final"));
    await session.handleNotification("turn/completed", {
      threadId: MAIN,
      turn: { id: "turn-main", status: "completed", error: null },
    });

    assert.equal(wasResolved(), true);
    assert.deepEqual(messages, ["main commentary", "main final"], "sub-agent output must not leak into the reply");
  });
});
