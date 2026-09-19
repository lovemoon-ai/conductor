import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexAppServerSession } from "../src/providers/codex-app-server-session.js";

describe("codex app-server session - v2 agentMessage boundaries", () => {
  it("emits a commentary agentMessage on its item/completed, not at the next message", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-msg-boundary-"));
    const session = new CodexAppServerSession("codex", { cwd, logger: { log: () => {} } });
    session.sessionId = "thread-main";
    const messages = [];
    session.on("assistant_message", (payload) => messages.push(payload.text));
    session.currentTurn = {
      turnId: "turn-1",
      fullText: "",
      activeAssistantMessageId: "",
      activeAssistantMessageText: "",
      resolve: () => {},
      reject: () => {},
    };
    const item = { type: "agentMessage", id: "m1", text: "checking the docs first", phase: "commentary" };

    await session.handleNotification("item/started", { threadId: "thread-main", turnId: "turn-1", item });
    await session.handleNotification("item/agentMessage/delta", {
      threadId: "thread-main",
      turnId: "turn-1",
      itemId: "m1",
      delta: "checking the docs first",
    });
    assert.deepEqual(messages, []);

    await session.handleNotification("item/completed", { threadId: "thread-main", turnId: "turn-1", item });
    assert.deepEqual(messages, ["checking the docs first"]);
  });
});
