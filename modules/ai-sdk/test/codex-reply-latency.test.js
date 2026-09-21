import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexAppServerSession } from "../src/providers/codex-app-server-session.js";

function setup({ suppressReply = false, debug = false } = {}) {
  const logs = [];
  const messages = [];
  const session = new CodexAppServerSession("codex", {
    logger: { log: (line) => logs.push(line) }, env: { CONDUCTOR_DEBUG: debug ? "1" : "0" },
  });
  session.currentTurn = {
    turnId: "turn-1", fullText: "", activeAssistantMessageText: "",
    activeAssistantMessageId: "", suppressReply, resolve() {},
  };
  session.setSessionMessageHandler((message) => messages.push(message.text));
  const notify = (method, params) => session.handleNotification(method, { turnId: "turn-1", ...params });
  return { session, messages, notify, logs };
}

describe("Codex reply latency diagnostics", () => {
  it("records per-item monotonic boundaries only with debug enabled", async (t) => {
    let now = 100;
    t.mock.method(performance, "now", () => now);
    const { session, notify, logs } = setup({ debug: true });
    session.currentTurn.startedAt = 0;
    session.setSessionReplyTarget("user-1");
    await notify("item/agentMessage/delta", { itemId: "one", delta: "sensitive content" });
    now = 150;
    await notify("item/completed", { item: { type: "agentMessage", id: "one" } });
    now = 200;
    await notify("item/agentMessage/delta", { itemId: "two", delta: "Final" });
    now = 225;
    await notify("item/completed", { item: { type: "agentMessage", id: "two" } });
    const events = logs.map((line) => JSON.parse(line.slice(line.indexOf("{"))));
    assert.deepEqual(events.map((event) => event.event), ["first_delta", "reply_emit", "first_delta", "reply_emit"]);
    assert.equal(events[0].turnStartToDeltaMs, 100);
    assert.equal(events[1].firstDeltaToEmitMs, 50);
    assert.equal(events[3].firstDeltaToEmitMs, 25);
    assert.equal(events[1].replyTo, "user-1");
    assert.ok(!JSON.stringify(events).includes("sensitive content"));
  });

  it("keeps diagnostics off by default and suppresses compaction traces", async () => {
    for (const options of [{}, { debug: true, suppressReply: true }]) {
      const { notify, logs } = setup(options);
      await notify("item/agentMessage/delta", { itemId: "one", delta: "Text" });
      await notify("item/completed", { item: { type: "agentMessage", id: "one" } });
      assert.deepEqual(logs, []);
    }
  });
});
