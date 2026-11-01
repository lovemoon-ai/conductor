import path from "node:path";
import os from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { ChatWebSession } from "../src/providers/chat-web-session.js";
import { startRuntimeServer } from "../../chat-web/src/runtime/server.ts";
import { RuntimeChatSession, ChatRuntimeClient } from "../../chat-web/src/runtime/client.ts";

describe("Conductor default Kimi and DeepSeek runtime", () => {
  it("keeps isolated memories, resumes stable task IDs, releases workers, and restores legacy URLs", async () => {
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-conductor-"));
    const configurations = [];
    const server = await startRuntimeServer({ directory, workerFactory: config => {
      configurations.push(config);
      let memory = "";
      return {
        async open() { return { ready: true, url: config.conversation.url, providerConversationId: config.conversation.providerConversationId }; },
        async send(input, _timeout, notify) {
          notify({ type: "submitting" });
          if (input !== "recall") memory = input;
          const text = input === "recall" ? memory || "restored" : input;
          notify({ type: "progress", text });
          return { text, url: (config.site.conversationUrl ?? "https://example.test/chat/") + (config.conversation.providerConversationId ?? "remote-" + config.conversation.id), providerConversationId: config.conversation.providerConversationId ?? "remote-" + config.conversation.id, source: config.site.format === "kimi" ? "connect" : "sse" };
        },
        cancel() {}, async close() {},
      };
    } });
    const client = new ChatRuntimeClient(server.socketPath);
    const mod = { RuntimeChatSession: { open: (provider, options) => RuntimeChatSession.open(provider, { ...options, socketPath: server.socketPath }) } };
    const sessions = [];
    const create = options => { const session = new ChatWebSession("chat-web", { ...options, chatWebModule: mod }); sessions.push(session); return session; };
    try {
      for (const provider of ["kimi", "deepseek"]) {
        const first = create({ model: provider });
        const second = create({ model: provider });
        const ids = await Promise.all([first, second].map(s => s.ensureSessionInfo()));
        assert.ok(ids.every(info => info.sessionId.startsWith("chat-web-runtime:")));
        assert.notEqual(ids[0].sessionId, ids[1].sessionId);
        assert.deepEqual((await Promise.all([first.runTurn("A"), second.runTurn("B")])).map(r => r.text), ["A", "B"]);
        assert.deepEqual((await Promise.all([first.runTurn("recall"), second.runTurn("recall")])).map(r => r.text), ["A", "B"]);
        const bareId = ids[0].sessionId.replace("chat-web-runtime:", "");
        await first.close();
        assert.equal((await client.get(bareId)).closed, true);
        const resumed = create({ model: provider, resumeSessionId: ids[0].sessionId });
        assert.equal((await resumed.ensureSessionInfo()).sessionId, ids[0].sessionId);
        await resumed.close(); await second.close();
        const legacy = create({ model: provider, resumeSessionId: "old-provider-id" });
        await legacy.ensureSessionInfo();
        assert.ok(configurations.some(c => c.conversation.provider === provider && c.conversation.url?.endsWith("/old-provider-id")));
        const legacyId = (await legacy.ensureSessionInfo()).sessionId;
        await legacy.close();
        const importedAgain = create({ model: provider, resumeSessionId: "old-provider-id" });
        assert.equal((await importedAgain.ensureSessionInfo()).sessionId, legacyId);
        await importedAgain.close();
      }
      assert.ok(configurations.filter(c => c.conversation.provider === "kimi").every(c => c.conversation.headless === false));
      assert.ok(configurations.filter(c => c.conversation.provider === "deepseek").every(c => c.conversation.headless === true));
      const before = (await client.list()).length;
      await assert.rejects(create({ model: "kimi", resumeSessionId: "chat-web-runtime:missing" }).ensureSessionInfo(), /not found/i);
      assert.equal((await client.list()).length, before);
      assert.equal(server.runtime.status().workers, 0);
    } finally { await Promise.allSettled(sessions.map(s => s.close())); await server.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });

  it("reports the Conductor login command before submitting an unauthenticated turn", async () => {
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-auth-ui-"));
    let sent = 0;
    let authenticated = false;
    const server = await startRuntimeServer({ directory, workerFactory: () => ({ async open() { return { ready: authenticated }; }, async send(input) { sent++; return { text: input }; }, cancel() {}, async close() {} }) });
    const session = new ChatWebSession("chat-web", { model: "deepseek", chatWebModule: { RuntimeChatSession: { open: (provider, options) => { assert.equal(options.socketPath, undefined); return RuntimeChatSession.open(provider, { ...options, socketPath: server.socketPath }); } } } });
    try {
      await assert.rejects(session.runTurn("must not send"), error => error.reason === "not_logged_in" && error.message.includes("conductor chat-web login deepseek"));
      assert.equal(sent, 0);
      assert.equal(server.runtime.status().workers, 0);
      const id = session.sessionId;
      authenticated = true;
      assert.equal((await session.runTurn("after login")).text, "after login");
      assert.equal(session.sessionId, id);
      assert.equal(sent, 1);
    } finally { await session.close(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });
  it("reports a confirmed runtime stop as interruption and keeps another chat usable", async () => {
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-stop-"));
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const server = await startRuntimeServer({ directory, workerFactory: () => {
      let rejectTurn;
      return {
        async open() { return { ready: true }; },
        async send(input, _timeout, notify) {
          notify({ type: "submitting" });
          if (input !== "hold") return { text: input };
          return new Promise((_resolve, reject) => { rejectTurn = reject; entered(); });
        },
        cancel() { rejectTurn?.(Object.assign(new Error("Generation stop observed"), { code: "CANCELLED", stopConfirmed: true })); },
        async close() {},
      };
    } });
    const mod = { RuntimeChatSession: { open: (provider, options) => RuntimeChatSession.open(provider, { ...options, socketPath: server.socketPath }) } };
    const first = new ChatWebSession("chat-web", { model: "kimi", chatWebModule: mod });
    const second = new ChatWebSession("chat-web", { model: "deepseek", chatWebModule: mod });
    const statuses = [];
    first.setWorkingStatusHandler(value => statuses.push(value));
    try {
      const checked = assert.rejects(first.runTurn("hold"), error => error.reason === "turn_cancelled" && error.turnStatus === "cancelled");
      await started;
      await first.interruptCurrentTurn();
      await checked;
      assert.equal(statuses.at(-1).phase, "turn_interrupted");
      assert.equal((await second.runTurn("still works")).text, "still works");
    } finally { await first.close(); await second.close(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });

  it("does not submit a turn stopped while the runtime is still opening", async () => {
    let opened;
    let complete;
    const opening = new Promise(resolve => { opened = resolve; });
    const gate = new Promise(resolve => { complete = resolve; });
    let sent = 0;
    const session = new ChatWebSession("chat-web", { model: "kimi", chatWebModule: {
      RuntimeChatSession: { async open() { opened(); await gate; return { id: "fixture", async isLoggedIn() { return true; }, async send() { sent++; return { response: "unexpected" }; }, async close() {} }; } },
    } });
    try {
      const checked = assert.rejects(session.runTurn("must not send"), { name: "AbortError" });
      await opening; await session.interruptCurrentTurn(); complete(); await checked;
      assert.equal(sent, 0);
    } finally { complete(); await session.close(); }
  });

});
