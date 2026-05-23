import { describe, expect, it } from "vitest";

import { NotLoggedInError } from "../src/core/errors.js";
import type { ChatProvider } from "../src/core/provider.js";
import { ChatSession } from "../src/session.js";

/**
 * Build a ChatSession backed by in-memory stubs so we can unit-test the
 * queueing / turn-counter / dispose semantics without launching Chromium.
 */
function buildStubSession(overrides: Partial<ChatProvider> = {}): {
  session: ChatSession;
  state: {
    sent: string[];
    contextClosed: boolean;
    newChatCalls: number;
    loggedIn: boolean;
  };
} {
  const state = {
    sent: [] as string[],
    contextClosed: false,
    newChatCalls: 0,
    loggedIn: true,
  };

  const provider: ChatProvider = {
    name: "stub",
    homeUrl: "https://stub.local",
    async open() {},
    async isLoggedIn() {
      return state.loggedIn;
    },
    async findInput() {
      throw new Error("not used");
    },
    async findSendButton() {
      return null;
    },
    async sendMessage(_page, message) {
      state.sent.push(message);
    },
    async waitForResponse(_page) {
      // Simulate streaming latency so we can prove the FIFO actually serialises.
      await new Promise((r) => setTimeout(r, 20));
      return `reply to: ${state.sent[state.sent.length - 1] ?? ""}`;
    },
    async extractLastAssistantMessage() {
      return "";
    },
    async newChat() {
      state.newChatCalls += 1;
    },
    ...overrides,
  };

  // Minimal BrowserContext / Page stubs — we only touch `context.close()`
  // and read `page.url()` indirectly. Cast through `unknown` because the
  // real Playwright types are huge and we deliberately only stub the
  // pieces our code path touches.
  const context = {
    async close() {
      state.contextClosed = true;
    },
  } as unknown as import("playwright").BrowserContext;

  const page = {
    url() {
      return "https://stub.local";
    },
  } as unknown as import("playwright").Page;

  const session = ChatSession.fromBrowser({
    provider,
    context,
    page,
    userDataDir: "/tmp/stub-profile",
  });

  return { session, state };
}

describe("ChatSession", () => {
  it("sends one message and returns the reply with a turn index", async () => {
    const { session } = buildStubSession();
    const r = await session.send("hello");
    expect(r.message).toBe("hello");
    expect(r.response).toBe("reply to: hello");
    expect(r.turnIndex).toBe(0);
    expect(r.durationMs).toBeGreaterThan(0);
    expect(session.turns).toBe(1);
    await session.close();
  });

  it("serialises concurrent sends FIFO (single-account guarantee)", async () => {
    const { session, state } = buildStubSession();

    const [a, b, c] = await Promise.all([
      session.send("one"),
      session.send("two"),
      session.send("three"),
    ]);

    // The provider's sendMessage should have seen them in submission order.
    expect(state.sent).toEqual(["one", "two", "three"]);
    // Each turn index is monotonic.
    expect([a.turnIndex, b.turnIndex, c.turnIndex]).toEqual([0, 1, 2]);
    await session.close();
  });

  it("throws NotLoggedInError when isLoggedIn returns false", async () => {
    const { session, state } = buildStubSession();
    state.loggedIn = false;
    await expect(session.send("hi")).rejects.toBeInstanceOf(NotLoggedInError);
    // A subsequent successful send should still work — one failure does
    // not wedge the queue.
    state.loggedIn = true;
    const r = await session.send("ok");
    expect(r.response).toBe("reply to: ok");
    await session.close();
  });

  it("newChat resets the turn counter and forwards to the provider", async () => {
    const { session, state } = buildStubSession();
    await session.send("a");
    await session.send("b");
    expect(session.turns).toBe(2);
    await session.newChat();
    expect(state.newChatCalls).toBe(1);
    expect(session.turns).toBe(0);
    const r = await session.send("c");
    expect(r.turnIndex).toBe(0);
    await session.close();
  });

  it("close() is idempotent and closes the underlying context exactly once", async () => {
    const { session, state } = buildStubSession();
    await session.close();
    await session.close();
    expect(state.contextClosed).toBe(true);
    expect(session.isClosed).toBe(true);
    await expect(session.send("post-close")).rejects.toThrow(/already closed/);
  });

  it("supports `await using` via Symbol.asyncDispose", async () => {
    const { session, state } = buildStubSession();
    await session[Symbol.asyncDispose]();
    expect(state.contextClosed).toBe(true);
    expect(session.isClosed).toBe(true);
  });
});
