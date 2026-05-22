import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EventEmitter } from "node:events";

import { ChatWebSession } from "../src/session-factory.js";
import { CHAT_WEB_SESSION_VARIANT } from "../src/built-in-backends.js";

/**
 * Build a stub chat-web module shaped like @love-moon/chat-web's runtime
 * surface. We only stub the parts ChatWebSession touches:
 *   - registerBuiltinProviders()
 *   - ChatSession.open(provider, options) → { isLoggedIn, send, close, ... }
 */
function createStubChatWebModule({
  loggedIn = true,
  sendImpl = null,
  openImpl = null,
} = {}) {
  const state = {
    registerCalls: 0,
    openCalls: [],
    sendCalls: [],
    closeCalls: 0,
  };

  class StubChatSession {
    constructor(provider, options) {
      this.provider = provider;
      this.userDataDir = `/tmp/stub-profile/${provider}`;
      this.openOptions = options || {};
      this.closed = false;
      this.turnCounter = 0;
      this.conversationId = undefined;
    }

    async isLoggedIn() {
      return loggedIn;
    }

    async send(message, options = {}) {
      if (this.closed) {
        const err = new Error("closed");
        err.reason = "session_closed";
        throw err;
      }
      state.sendCalls.push({ provider: this.provider, message, options });
      if (typeof sendImpl === "function") {
        const result = await sendImpl(message, options, this);
        if (result?.conversationId) this.conversationId = result.conversationId;
        return result;
      }
      const turnIndex = this.turnCounter++;
      return {
        turnIndex,
        message,
        response: `stub reply to: ${message}`,
        durationMs: 1,
      };
    }

    async close() {
      this.closed = true;
      state.closeCalls += 1;
    }
  }

  const mod = {
    registerBuiltinProviders() {
      state.registerCalls += 1;
    },
    ChatSession: {
      async open(provider, options) {
        state.openCalls.push({ provider, options });
        if (typeof openImpl === "function") {
          return await openImpl(provider, options);
        }
        return new StubChatSession(provider, options);
      },
    },
  };

  return { mod, state };
}

describe("ChatWebSession", () => {
  it("defaults to the chatgpt sub-provider", () => {
    const { mod } = createStubChatWebModule();
    const s = new ChatWebSession("chat-web", { chatWebModule: mod });
    assert.equal(s.chatWebProvider, "chatgpt");
    assert.equal(s.threadOptions.model, "chatgpt");
    assert.equal(s.threadOptions.modelProvider, "chat-web");
  });

  it("honours explicit chatWebProvider=gemini", () => {
    const { mod } = createStubChatWebModule();
    const s = new ChatWebSession("chat-web", {
      chatWebModule: mod,
      chatWebProvider: "gemini",
    });
    assert.equal(s.chatWebProvider, "gemini");
  });

  it("honours model=gemini as a fallback selector", () => {
    const { mod } = createStubChatWebModule();
    const s = new ChatWebSession("chat-web", {
      chatWebModule: mod,
      model: "gemini",
    });
    assert.equal(s.chatWebProvider, "gemini");
  });

  it("treats openai / gpt aliases as chatgpt; google as gemini", () => {
    const { mod } = createStubChatWebModule();
    assert.equal(
      new ChatWebSession("chat-web", { chatWebModule: mod, model: "openai" }).chatWebProvider,
      "chatgpt",
    );
    assert.equal(
      new ChatWebSession("chat-web", { chatWebModule: mod, model: "google" }).chatWebProvider,
      "gemini",
    );
    assert.equal(
      new ChatWebSession("chat-web", { chatWebModule: mod, model: "ai-studio" }).chatWebProvider,
      "gemini",
    );
  });

  it("ignores unknown model values and falls back to chatgpt", () => {
    const { mod } = createStubChatWebModule();
    const s = new ChatWebSession("chat-web", { chatWebModule: mod, model: "claude" });
    assert.equal(s.chatWebProvider, "chatgpt");
  });

  it("boots a ChatSession and registers builtin providers exactly once", async () => {
    const { mod, state } = createStubChatWebModule();
    const s = new ChatWebSession("chat-web", { chatWebModule: mod });
    await s.boot();
    await s.boot(); // idempotent
    assert.equal(state.registerCalls, 1);
    assert.equal(state.openCalls.length, 1);
    assert.equal(state.openCalls[0].provider, "chatgpt");
    assert.equal(state.openCalls[0].options.headless, true);
    await s.close();
  });

  it("adapts the ai-sdk logger to chat-web's logger shape (regression: logger.debug crash)", async () => {
    const { mod, state } = createStubChatWebModule();
    const logs = [];
    const aiSdkLogger = { log: (m) => logs.push(m) };
    const s = new ChatWebSession("chat-web", { chatWebModule: mod, logger: aiSdkLogger });
    await s.boot();

    assert.equal(state.openCalls.length, 1);
    const passedLogger = state.openCalls[0].options.logger;
    // Must expose chat-web's { error, warn, info, debug } surface — the
    // original ai-sdk logger only had `log`, so this proves the adapter ran.
    for (const level of ["error", "warn", "info", "debug"]) {
      assert.equal(typeof passedLogger?.[level], "function", `missing ${level}() on adapted logger`);
    }
    // Each level must route through to the ai-sdk logger's `log` channel
    // (this is the exact path that used to crash on chat-web's debug call).
    passedLogger.debug("hello", { from: "test" });
    assert.ok(
      logs.some((line) => line.includes("[chat-web debug]") && line.includes("hello")),
      `expected adapter to forward debug() to log(); got ${JSON.stringify(logs)}`,
    );

    await s.close();
  });

  it("logger adapter survives a missing log() method", async () => {
    const { mod, state } = createStubChatWebModule();
    // No-op logger (e.g. when caller passes `{}` or `undefined`). The adapter
    // must still produce callable functions so chat-web's internal
    // logger.debug() doesn't blow up.
    const s = new ChatWebSession("chat-web", { chatWebModule: mod, logger: {} });
    await s.boot();
    const passedLogger = state.openCalls[0].options.logger;
    assert.doesNotThrow(() => passedLogger.debug("anything"));
    assert.doesNotThrow(() => passedLogger.error(new Error("boom")));
    await s.close();
  });

  it("runTurn sends through ChatSession.send and emits assistant_message", async () => {
    const { mod, state } = createStubChatWebModule();
    const s = new ChatWebSession("chat-web", { chatWebModule: mod, model: "gemini" });
    const messages = [];
    const workingEvents = [];
    s.on("assistant_message", (payload) => messages.push(payload));
    s.on("working_status", (payload) => workingEvents.push(payload));

    const result = await s.runTurn("hello");

    assert.equal(state.sendCalls.length, 1);
    assert.equal(state.sendCalls[0].provider, "gemini");
    assert.equal(state.sendCalls[0].message, "hello");
    assert.equal(result.text, "stub reply to: hello");
    assert.equal(result.provider, "chat-web");
    assert.equal(result.metadata.source, CHAT_WEB_SESSION_VARIANT);
    assert.equal(result.metadata.chatWebProvider, "gemini");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, "stub reply to: hello");
    // We expect at least: turn_started (reply_in_progress=true) and a
    // terminal status (reply_in_progress=false).
    assert.ok(workingEvents.some((e) => e.phase === "turn_started" && e.reply_in_progress));
    assert.ok(workingEvents.some((e) => e.phase === "turn_completed" && !e.reply_in_progress));

    await s.close();
  });

  it("returns empty result with no send call for an empty prompt", async () => {
    const { mod, state } = createStubChatWebModule();
    const s = new ChatWebSession("chat-web", { chatWebModule: mod });
    const result = await s.runTurn("   ");
    assert.equal(result.text, "");
    assert.equal(state.sendCalls.length, 0);
    await s.close();
  });

  it("emits auth_required and rejects when the underlying provider is not logged in", async () => {
    const { mod } = createStubChatWebModule({ loggedIn: false });
    const s = new ChatWebSession("chat-web", { chatWebModule: mod });
    const authEvents = [];
    s.on("auth_required", (payload) => authEvents.push(payload));

    await assert.rejects(
      s.runTurn("hi"),
      (err) => {
        assert.equal(err.reason, "not_logged_in");
        assert.match(err.message, /chat-web login chatgpt/);
        return true;
      },
    );
    assert.equal(authEvents.length, 1);
    assert.equal(authEvents[0].reason, "login_required");

    await s.close();
  });

  it("close() tears down the underlying ChatSession and is idempotent", async () => {
    const { mod, state } = createStubChatWebModule();
    const s = new ChatWebSession("chat-web", { chatWebModule: mod });
    await s.boot();
    await s.close();
    await s.close();
    assert.equal(state.closeCalls, 1);
  });

  it("rejects a second concurrent runTurn while one is already in progress", async () => {
    let releaseFirstSend = null;
    const firstSendStarted = new Promise((resolve) => {
      releaseFirstSend = resolve;
    });
    const sendImpl = async (message) => {
      releaseFirstSend?.();
      await new Promise((r) => setTimeout(r, 40));
      return { turnIndex: 0, message, response: "ok", durationMs: 40 };
    };
    const { mod } = createStubChatWebModule({ sendImpl });
    const s = new ChatWebSession("chat-web", { chatWebModule: mod });

    const first = s.runTurn("first");
    await firstSendStarted;
    await assert.rejects(s.runTurn("second"), (err) => {
      assert.equal(err.reason, "turn_already_running");
      return true;
    });
    await first;
    await s.close();
  });

  it("adopts the ChatGPT /c/{uuid} conversation id as the session id after the first turn", async () => {
    const conversationUuid = "6a103f7e-bd94-83ea-ae46-9652657bbedf";
    const sendImpl = async (message) => ({
      turnIndex: 0,
      message,
      response: "reply",
      durationMs: 1,
      conversationId: conversationUuid,
    });
    const { mod } = createStubChatWebModule({ sendImpl });
    const s = new ChatWebSession("chat-web", { chatWebModule: mod });

    const initialId = s.sessionId;
    // Synthetic id at construction, BEFORE first turn.
    assert.match(initialId, /^chat-web-chatgpt-/);

    const sessionEvents = [];
    s.on("session", (info) => sessionEvents.push(info));

    const result = await s.runTurn("hello");

    // sessionId promoted to the conversation UUID.
    assert.equal(s.sessionId, conversationUuid);
    assert.equal(s.providerConversationId, conversationUuid);
    assert.equal(result.metadata.conversationId, conversationUuid);
    assert.equal(result.metadata.providerUrl, `https://chatgpt.com/c/${conversationUuid}`);

    // A `session` event fires for the promotion so the daemon / UI can react.
    const promotion = sessionEvents.find((e) => e?.sessionId === conversationUuid);
    assert.ok(promotion, "expected a session event after conversation id promotion");
    assert.equal(promotion.providerConversationId, conversationUuid);

    await s.close();
  });

  it("falls back to ChatSession.conversationId if SendResult doesn't include it", async () => {
    const conversationUuid = "11111111-2222-3333-4444-555555555555";
    // The stub's `send()` calls `sendImpl(message, options, this)` —
    // `this` is the third argument, not the function's receiver. Set
    // the conversationId on the session object via that 3rd arg so we
    // simulate the case where the adapter populated it via post-nav
    // capture but didn't include it on the SendResult.
    const sendImpl = async (message, _options, session) => {
      session.conversationId = conversationUuid;
      return { turnIndex: 0, message, response: "reply", durationMs: 1 };
    };
    const { mod } = createStubChatWebModule({ sendImpl });
    const s = new ChatWebSession("chat-web", { chatWebModule: mod });

    const result = await s.runTurn("hi");
    assert.equal(s.sessionId, conversationUuid);
    assert.equal(result.metadata.conversationId, conversationUuid);

    await s.close();
  });

  it("does not promote sessionId when no conversation id is available", async () => {
    const { mod } = createStubChatWebModule(); // default sendImpl never sets conversationId
    const s = new ChatWebSession("chat-web", { chatWebModule: mod, chatWebProvider: "gemini" });
    const initialId = s.sessionId;
    const result = await s.runTurn("hello");
    assert.equal(s.sessionId, initialId);
    assert.equal(result.metadata.conversationId, undefined);
    assert.equal(result.metadata.providerUrl, undefined);
    await s.close();
  });

  it("idempotent: re-promoting the same conversation id does not emit a duplicate session event", async () => {
    const conversationUuid = "abcabcab-0000-0000-0000-abcabcabcabc";
    const sendImpl = async (message) => ({
      turnIndex: 0,
      message,
      response: "reply",
      durationMs: 1,
      conversationId: conversationUuid,
    });
    const { mod } = createStubChatWebModule({ sendImpl });
    const s = new ChatWebSession("chat-web", { chatWebModule: mod });
    const sessionEvents = [];
    s.on("session", (info) => sessionEvents.push(info));

    await s.runTurn("turn 1");
    await s.runTurn("turn 2");

    // Two turns, same conversation id → exactly one promotion-shaped session
    // event (plus the initial session-ready event from boot).
    const promotions = sessionEvents.filter((e) => e?.sessionId === conversationUuid);
    assert.equal(promotions.length, 1, `expected exactly one promotion event, got ${promotions.length}`);

    await s.close();
  });

  it("snapshot exposes the chat-web provider variant and sub-provider", () => {
    const { mod } = createStubChatWebModule();
    const s = new ChatWebSession("chat-web", {
      chatWebModule: mod,
      chatWebProvider: "gemini",
    });
    const snap = s.getSnapshot();
    assert.equal(snap.backend, "chat-web");
    assert.equal(snap.provider, CHAT_WEB_SESSION_VARIANT);
    assert.equal(snap.chatWebProvider, "gemini");
    assert.equal(snap.useSessionFileReplyStream, false);
  });

  it("inherits from EventEmitter for downstream subscribers", () => {
    const { mod } = createStubChatWebModule();
    const s = new ChatWebSession("chat-web", { chatWebModule: mod });
    assert.ok(s instanceof EventEmitter);
  });
});
