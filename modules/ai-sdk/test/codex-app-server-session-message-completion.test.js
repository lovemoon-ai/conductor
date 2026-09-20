import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { CodexAppServerSession } from "../src/providers/codex-app-server-session.js";

function activeSession({ suppressReply = false } = {}) {
  const session = new CodexAppServerSession("codex", { cwd: os.tmpdir(), logger: { log() {} } });
  session.currentTurn = {
    turnId: "turn-1", fullText: "", activeAssistantMessageId: "",
    activeAssistantMessageText: "", suppressReply, resolve() {}, reject(error) { throw error; },
  };
  const messages = [];
  session.setSessionMessageHandler(({ text }) => messages.push(text));
  const notify = (method, params) => session.handleNotification(method, { turnId: "turn-1", ...params });
  const reply = async (id, text, type = "agentMessage") => {
    const item = { id, type, text, phase: "commentary" };
    await notify("item/started", { item });
    await notify("item/agentMessage/delta", { itemId: id, delta: text });
    await notify("item/completed", { item });
  };
  return { session, messages, notify, reply };
}

describe("codex app-server assistant message completion", () => {
  for (const type of ["agentMessage", "message", "agent_message"]) {
    it(`delivers ${type} before the following tool or turn completes`, async () => {
      const { session, messages, notify, reply } = activeSession();
      await reply("commentary", "I will run the tests.", type);
      await notify("item/started", { item: { id: "tool", type: "commandExecution", command: "pnpm test" } });
      assert.deepEqual(messages, ["I will run the tests."]);
      assert.ok(session.currentTurn, "the turn must still be running when the reply is delivered");
      await notify("item/completed", { item: { id: "tool", type: "commandExecution" } });
      await reply("final", "Tests passed.", type);
      await notify("item/completed", { item: { id: "final", type, text: "Tests passed." } });
      await notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
      assert.deepEqual(messages, ["I will run the tests.", "Tests passed."], "repeated completion and turn fallback must not duplicate messages");
    });
  }

  it("does not flush a different active message on a late completion", async () => {
    const { messages, notify, reply } = activeSession();
    await reply("first", "First reply.");
    await notify("item/agentMessage/delta", { itemId: "second", delta: "Second reply." });
    await notify("item/completed", { item: { id: "first", type: "agentMessage", text: "First reply." } });
    assert.deepEqual(messages, ["First reply."]);
    await notify("item/completed", { item: { id: "second", type: "agentMessage", text: "Second reply." } });
    assert.deepEqual(messages, ["First reply.", "Second reply."]);
  });

  it("still suppresses assistant messages during compaction", async () => {
    const { messages, notify, reply } = activeSession({ suppressReply: true });
    await reply("compact", "Internal summary.");
    await notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    assert.deepEqual(messages, []);
  });

  it("keeps a final delta and completion in the same transport batch in one reply", async () => {
    const { session, messages, notify } = activeSession();
    await notify("item/agentMessage/delta", { itemId: "reply", delta: "Hello " });
    session.transport.handleStdoutLine(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { turnId: "turn-1", itemId: "reply", delta: "world." },
    }));
    session.transport.handleStdoutLine(JSON.stringify({
      method: "item/completed",
      params: { turnId: "turn-1", item: { id: "reply", type: "agentMessage", text: "Hello world." } },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(messages, ["Hello world."], "the complete reply must arrive before a later tool or turn ends");
    await notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    assert.deepEqual(messages, ["Hello world."], "turn completion must not deliver a stranded suffix");
  });
});
