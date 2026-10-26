import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatWebSession } from "../src/providers/chat-web-session.js";
import { startRuntimeServer } from "../../chat-web/src/runtime/server.ts";
import { RuntimeChatSession, ChatRuntimeClient } from "../../chat-web/src/runtime/client.ts";
import { runtimeSites } from "../../chat-web/src/runtime/sites.ts";

describe("AI SDK socket chat runtime", () => {
  it("keeps the runtime id stable across provider replies and detaches without closing shared chat", async () => {
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-ai-"));
    const server = await startRuntimeServer({ directory, sites: runtimeSites, workerFactory: (config) => ({
      async open() { return { ready: true }; },
      async send(input, _timeout, notify) {
        notify({ type: "submitting" });
        notify({ type: "progress", text: "hello:" + input });
        return { text: "hello:" + input, url: "https://claude.ai/chat/remote-thread", providerConversationId: "remote-thread" };
      },
      cancel() {},
      async close() {},
    }) });
    const options = { chatWebModule: { RuntimeChatSession }, chatWebRuntimeSocket: server.socketPath, chatWebProvider: "claude" };
    const session = new ChatWebSession("chat-web", options);
    let resumed;
    try {
      const info = await session.ensureSessionInfo();
      const id = info.sessionId;
      assert.equal(info.sessionIdDeferred, false);
      assert.equal(session.getSnapshot().capabilities.clear, false);
      const reply = await session.runTurn("one");
      assert.equal(reply.text, "hello:one");
      assert.equal(reply.metadata.sessionId, id);
      assert.equal(reply.metadata.conversationId, "remote-thread");
      await session.close();
      const client = new ChatRuntimeClient(server.socketPath);
      assert.equal((await client.get(id)).closed, false);
      resumed = new ChatWebSession("chat-web", { ...options, resumeSessionId: id });
      assert.equal((await resumed.ensureSessionInfo()).sessionId, id);
      assert.equal((await resumed.runTurn("two")).text, "hello:two");
      assert.equal((await client.list()).length, 1);
      await assert.rejects(resumed.runClear(), /new runtime conversation/);
    } finally {
      await session.close();
      await resumed?.close();
      await server.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("AI SDK DeepThink", () => {
  it("forwards explicit false on resume and rejects unsupported usage", async () => {
    let opened;
    const session = new ChatWebSession("chat-web", {
      chatWebProvider: "deepseek", chatWebRuntimeSocket: "/unused/runtime.sock",
      chatWebConversationId: "existing", chatWebDeepThink: false,
      chatWebModule: { RuntimeChatSession: { async open(provider, options) {
        opened = { provider, ...options };
        return { id: "existing", async isLoggedIn() { return true; }, async close() {} };
      } } },
    });
    try {
      await session.ensureSessionInfo();
      assert.equal(opened.deepThink, false);
      assert.equal(opened.conversationId, "existing");
    } finally { await session.close(); }
    assert.throws(() => new ChatWebSession("chat-web", { chatWebProvider: "deepseek", chatWebDeepThink: true }), /chatWebRuntimeSocket/);
    assert.throws(() => new ChatWebSession("chat-web", { chatWebProvider: "kimi", chatWebRuntimeSocket: "/unused", chatWebDeepThink: true }), /DeepSeek/);
  });
});
