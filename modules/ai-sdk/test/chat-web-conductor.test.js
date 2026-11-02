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
    const server = await startRuntimeServer({ directory, workerFactory: () => ({ async open() { return { ready: authenticated, authRequired: !authenticated }; }, async send(input) { sent++; return { text: input }; }, cancel() {}, async close() {} }) });
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

describe("runtime startup under load", () => {
  it("queues more SDK sessions than maxWorkers and checks authentication when their worker is allocated", async () => {
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-start-"));
    let active = 0, peak = 0, sent = 0;
    const server = await startRuntimeServer({ directory, maxWorkers: 2, perAccountConcurrency: 2, workerFactory: config => ({
      async open() { await new Promise(resolve => setTimeout(resolve, 10)); return { ready: true, url: "https://example.test/chat/" + config.conversation.id }; },
      async send(input, _timeout, notify) {
        active++; peak = Math.max(peak, active); sent++; notify({ type: "submitting" });
        await new Promise(resolve => setTimeout(resolve, 50)); active--;
        return { text: input, url: "https://example.test/chat/" + config.conversation.id };
      }, cancel() {}, async close() {},
    }) });
    const statuses = [];
    const mod = { RuntimeChatSession: { open: (provider, options) => RuntimeChatSession.open(provider, { ...options, socketPath: server.socketPath }) } };
    const sessions = Array.from({ length: 6 }, (_, i) => new ChatWebSession("chat-web", { model: i % 2 ? "kimi" : "deepseek", chatWebModule: mod }));
    for (const s of sessions) s.setWorkingStatusHandler(status => statuses.push(status));
    try {
      const infos = await Promise.all(sessions.map(s => s.ensureSessionInfo()));
      assert.equal(new Set(infos.map(i => i.sessionId)).size, 6);
      assert.ok(server.runtime.status().workers <= 2);
      const results = await Promise.all(sessions.map((s, i) => s.runTurn("job-" + i)));
      assert.deepEqual(results.map(r => r.text), Array.from({ length: 6 }, (_, i) => "job-" + i));
      assert.equal(sent, 6); assert.equal(peak, 2);
      assert.ok(statuses.some(s => s.phase === "queued" && s.status_line.includes("waiting")));
    } finally { await Promise.allSettled(sessions.map(s => s.close())); await server.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });

  it("reconnects an active chat without failing boot or resending its in-flight prompt", async () => {
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-reconnect-"));
    let entered, release;
    const running = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const calls = [];
    const server = await startRuntimeServer({ directory, maxWorkers: 1, workerFactory: () => ({
      async open() { return { ready: true }; },
      async send(input, _timeout, notify) {
        calls.push(input); notify({ type: "submitting" });
        if (input === "first") { entered(); await gate; }
        return { text: input };
      }, cancel() {}, async close() { release(); },
    }) });
    const mod = { RuntimeChatSession: { open: (provider, options) => RuntimeChatSession.open(provider, { ...options, socketPath: server.socketPath }) } };
    const original = new ChatWebSession("chat-web", { model: "deepseek", chatWebModule: mod });
    let restored;
    try {
      const id = (await original.ensureSessionInfo()).sessionId;
      const first = original.runTurn("first"); await running;
      restored = new ChatWebSession("chat-web", { model: "deepseek", resumeSessionId: id, chatWebModule: mod });
      assert.equal((await restored.ensureSessionInfo()).sessionId, id);
      const later = restored.runTurn("later");
      release();
      assert.equal((await first).text, "first");
      assert.equal((await later).text, "later");
      assert.deepEqual(calls, ["first", "later"]);
    } finally { release(); await original.close(); await restored?.close(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });
  it("reports login required without submitting when authentication was deferred behind a busy worker", async () => {
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-deferred-auth-"));
    let entered, release;
    const running = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const sent = [];
    const server = await startRuntimeServer({ directory, maxWorkers: 1, workerFactory: config => ({
      async open() { return { ready: config.conversation.provider !== "kimi", authRequired: config.conversation.provider === "kimi", url: "https://example.test/chat/" + config.conversation.id }; },
      async send(input, _timeout, notify) { sent.push(input); notify({ type: "submitting" }); entered(); await gate; return { text: input }; },
      cancel() {}, async close() { release(); },
    }) });
    const mod = { RuntimeChatSession: { open: (provider, options) => RuntimeChatSession.open(provider, { ...options, socketPath: server.socketPath }) } };
    const first = new ChatWebSession("chat-web", { model: "deepseek", chatWebModule: mod });
    const deferred = new ChatWebSession("chat-web", { model: "kimi", chatWebModule: mod });
    try {
      const held = first.runTurn("held"); await running;
      await deferred.ensureSessionInfo();
      const rejected = assert.rejects(deferred.runTurn("must not submit"), error => error.reason === "not_logged_in" && error.message.includes("conductor chat-web login kimi"));
      release(); await held; await rejected;
      assert.deepEqual(sent, ["held"]);
    } finally { release(); await first.close(); await deferred.close(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });

  it("queues boot while all worker slots belong to pinned login windows", async () => {
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-pinned-boot-"));
    const server = await startRuntimeServer({ directory, maxWorkers: 1, workerFactory: () => ({
      async open() { return { ready: true }; }, async send(input) { return { text: input }; }, cancel() {}, async close() {},
    }) });
    const client = new ChatRuntimeClient(server.socketPath);
    const pinned = await client.create({ provider: "kimi" });
    await client.resume(pinned.id, { headed: true });
    const session = new ChatWebSession("chat-web", { model: "deepseek", chatWebModule: { RuntimeChatSession: { open: (provider, options) => RuntimeChatSession.open(provider, { ...options, socketPath: server.socketPath }) } } });
    try {
      const info = await session.ensureSessionInfo();
      assert.ok(info.sessionId.startsWith("chat-web-runtime:"));
      const result = session.runTurn("after login");
      for (let i = 0; i < 100; i++) {
        const state = JSON.parse(await fs.readFile(path.join(directory, "state.json"), "utf8"));
        if (Object.values(state.turns).some(t => t.status === "queued")) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await client.closeConversation(pinned.id);
      assert.equal((await result).text, "after login");
    } finally { await session.close(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });

});

describe("Conductor resume after runtime profile retention", () => {
  for (const provider of ["kimi", "deepseek"]) it("restores the first " + provider + " conversation after closing 34 managed sessions and restarting", async () => {
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-archive-"));
    const memory = new Map(), configurations = [];
    const options = { directory, workerFactory: config => {
      configurations.push(config);
      const providerId = config.conversation.providerConversationId ?? "provider-" + config.conversation.id;
      const url = config.site.conversationUrl + providerId;
      return {
        async open() {
          await fs.mkdir(config.profileDir, { recursive: true });
          return { ready: true };
        },
        async send(input) {
          if (input !== "recall") memory.set(providerId, input);
          return { text: input === "recall" ? memory.get(providerId) : input, providerConversationId: providerId, url };
        }, cancel() {}, async close() {},
      };
    } };
    let server = await startRuntimeServer(options);
    let session;
    const create = id => new ChatWebSession("chat-web", { model: provider, resumeSessionId: id, chatWebModule: {
      RuntimeChatSession: { open: (p, opts) => RuntimeChatSession.open(p, { ...opts, socketPath: server.socketPath }) },
    } });
    let firstId, firstProviderId, firstUrl;
    try {
      for (let i = 0; i < 34; i++) {
        session = create();
        await session.runTurn("marker-" + i);
        const id = (await session.ensureSessionInfo()).sessionId;
        if (i === 0) {
          firstId = id;
          const original = server.runtime.get(id.replace("chat-web-runtime:", ""));
          firstProviderId = original.providerConversationId; firstUrl = original.url;
        }
        await session.close();
      }
      const localId = firstId.replace("chat-web-runtime:", "");
      assert.equal(server.runtime.list().length, 32);
      assert.equal(server.runtime.get(localId).archived, true);
      assert.equal(await fs.stat(path.join(directory, "profiles", localId)).then(() => true, () => false), false);
      await server.close();
      server = await startRuntimeServer(options);
      session = create(firstId);
      assert.equal((await session.ensureSessionInfo()).sessionId, firstId);
      assert.equal((await session.runTurn("recall")).text, "marker-0");
      const restored = server.runtime.get(localId);
      assert.equal(restored.providerConversationId, firstProviderId);
      assert.equal(restored.url, firstUrl);
      assert.equal(restored.archived, undefined);
      assert.equal(configurations.at(-1).conversation.url, firstUrl);
      assert.equal(configurations.at(-1).conversation.providerConversationId, firstProviderId);
      assert.equal(await fs.stat(path.join(directory, "profiles", localId)).then(() => true, () => false), true);
    } finally { await session?.close(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });

  it("reports page readiness failures without asking the user to renew login", async () => {
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-load-"));
    const server = await startRuntimeServer({ directory, workerFactory: () => ({
      async open() { return { ready: false, authRequired: false }; },
      async send() { throw new Error("must not send"); }, cancel() {}, async close() {},
    }) });
    const session = new ChatWebSession("chat-web", { model: "kimi", chatWebModule: { RuntimeChatSession: { open: (p, opts) => RuntimeChatSession.open(p, { ...opts, socketPath: server.socketPath }) } } });
    const authEvents = [];
    session.on("auth_required", event => authEvents.push(event));
    try {
      await assert.rejects(session.runTurn("hello"), error => error.code === "PAGE_NOT_READY" && !/login|renewal/i.test(error.message));
      assert.deepEqual(authEvents, []);
    } finally { await session.close(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });
});
