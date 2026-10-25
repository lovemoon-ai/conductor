import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { brokerPaths } from "../src/core/broker-protocol.js";
import { startTurnBroker } from "../src/core/turn-broker.js";
import type { ChatProvider } from "../src/core/provider.js";
import { QueuedChatSession } from "../src/queued-session.js";

async function until(test: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("cross-session turn broker", () => {
  let home: string;
  let previousHome: string | undefined;
  let broker: Awaited<ReturnType<typeof startTurnBroker>>;
  let sessions: QueuedChatSession[];
  let events: string[];
  let closedContext: boolean;
  let pageCount: number;
  let launches: number;
  let crashBrowser: () => void;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "turn-broker-"));
    previousHome = process.env.CHAT_WEB_HOME;
    process.env.CHAT_WEB_HOME = home;
    sessions = []; events = []; closedContext = false; pageCount = 0; launches = 0;
    const memory = new WeakMap<Page, { value: string; message: string; closed: boolean }>();
    const provider: ChatProvider = {
      name: "stub", homeUrl: "https://stub.local/",
      async open() {}, async isLoggedIn() { return true; },
      async findInput() { throw new Error("not used"); }, async findSendButton() { return null; },
      async extractLastAssistantMessage() { return ""; },
      async sendMessage(page, message) {
        events.push(`start:${message}`);
        const state = memory.get(page)!; state.message = message;
        if (message.startsWith("remember:")) state.value = message.slice(9);
        if (message === "fail") throw new Error("provider failure");
      },
      async waitForResponse(page, options = {}) {
        const state = memory.get(page)!;
        if (state.message === "uncooperative") {
          await new Promise((resolve) => setTimeout(resolve, 250));
          events.push("end:uncooperative");
          return "late reply";
        }
        const duration = state.message === "slow" ? 1000 : 60;
        const timeout = options.timeoutMs ?? 10000;
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
          const timer = setTimeout(() => {
            options.signal?.removeEventListener("abort", abort);
            if (duration >= timeout) reject(new Error("provider timeout")); else resolve();
          }, Math.min(duration, timeout));
          options.signal?.addEventListener("abort", abort, { once: true });
        });
        options.onProgress?.(state.value);
        events.push(`end:${state.message}`);
        return state.value || "empty";
      },
      async newChat(page) { memory.get(page)!.value = ""; },
      getConversationId(page) { return page.url().split("/").at(-1)!; },
      async stopGeneration(page) { events.push(`stop:${memory.get(page)!.message}`); },
    };
    const lifecycle = new EventEmitter();
    crashBrowser = () => { lifecycle.emit("close"); };
    const context = {
      once: lifecycle.once.bind(lifecycle),
      async newPage() {
        const id = ++pageCount;
        const page = {
          url: () => `https://stub.local/chat/${id}`,
          async bringToFront() {},
          async close() { const state = memory.get(page)!; state.closed = true; events.push(`close:${state.message}`); },
        } as unknown as Page;
        memory.set(page, { value: "", message: "", closed: false });
        return page;
      },
      async close() { closedContext = true; lifecycle.emit("close"); },
    } as unknown as BrowserContext;
    broker = await startTurnBroker({
      socketPath: brokerPaths("stub").socket, provider,
      idleMs: 200,
      launch: async () => { launches++; return { context, page: {} as Page, userDataDir: home }; },
    });
  });

  afterEach(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    await broker.close();
    if (previousHome === undefined) delete process.env.CHAT_WEB_HOME; else process.env.CHAT_WEB_HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  async function open(): Promise<QueuedChatSession> {
    const session = await QueuedChatSession.open("stub");
    sessions.push(session);
    return session;
  }

  it("shares one browser, switches A1/B1/A2, and isolates conversation memory", async () => {
    const [a, b] = await Promise.all([open(), open()]);
    const a1 = a.send("remember:RED");
    await until(() => events.includes("start:remember:RED"));
    const positions: number[] = [];
    const b1 = b.send("remember:BLUE", { onQueue: (n) => positions.push(n) });
    const a2 = a.send("recall");
    const [first, second, third] = await Promise.all([a1, b1, a2]);
    expect([first.response, second.response, third.response]).toEqual(["RED", "BLUE", "RED"]);
    expect(events.filter((e) => e.startsWith("start:"))).toEqual(["start:remember:RED", "start:remember:BLUE", "start:recall"]);
    expect(positions).toContain(1);
    expect(positions.at(-1)).toBe(0);
    expect(first.conversationId).toBe(third.conversationId);
    expect(first.conversationId).not.toBe(second.conversationId);
    expect(launches).toBe(1);
    expect(pageCount).toBe(2);
    await a.close();
    expect(closedContext).toBe(false);
    expect((await b.send("recall")).response).toBe("BLUE");
  });

  it("resets only one conversation and retains the other", async () => {
    const [a, b] = await Promise.all([open(), open()]);
    await Promise.all([a.send("remember:A"), b.send("remember:B")]);
    await a.newChat();
    expect((await a.send("recall")).response).toBe("empty");
    expect((await b.send("recall")).response).toBe("B");
    expect(a.turns).toBe(1);
    expect(b.turns).toBe(2);
  });

  it("does not charge queue wait against the generation timeout", async () => {
    const [a, b] = await Promise.all([open(), open()]);
    const first = a.send("slow");
    await until(() => events.includes("start:slow"));
    // B's response takes 60ms; it waits about 1s for A before that clock starts.
    const second = b.send("remember:B", { timeoutMs: 150 });
    await first;
    expect((await second).response).toBe("B");
  });

  it("cancels a queued turn without submitting or closing its conversation", async () => {
    const [a, b] = await Promise.all([open(), open()]);
    const first = a.send("slow");
    await until(() => events.includes("start:slow"));
    const controller = new AbortController();
    const positions: number[] = [];
    const pending = b.send("cancelled", { signal: controller.signal, onQueue: (n) => positions.push(n) });
    const checked = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await until(() => positions.includes(1));
    controller.abort();
    await checked;
    const next = b.send("remember:B");
    await first;
    expect((await next).response).toBe("B");
    expect(events).not.toContain("start:cancelled");
  });

  it("stops and closes a failed tab before allowing the next turn", async () => {
    const [a, b] = await Promise.all([open(), open()]);
    const checked = expect(a.send("fail")).rejects.toThrow("provider failure");
    const next = b.send("remember:B");
    await checked;
    expect((await next).response).toBe("B");
    expect(events.indexOf("close:fail")).toBeLessThan(events.indexOf("start:remember:B"));
    expect(events).toContain("stop:fail");
    await expect(a.send("retry")).rejects.toMatchObject({ code: "BROKER_SESSION_CLOSED" });
  });

  it("releases a timed-out tab and continues the queue", async () => {
    const [a, b] = await Promise.all([open(), open()]);
    const checked = expect(a.send("slow", { timeoutMs: 20 })).rejects.toMatchObject({ code: "RESPONSE_TIMEOUT" });
    const next = b.send("remember:B");
    await checked;
    expect((await next).response).toBe("B");
    expect(events.indexOf("close:slow")).toBeLessThan(events.indexOf("start:remember:B"));
  });

  it("closing an active task cancels its turn and unblocks B", async () => {
    const [a, b] = await Promise.all([open(), open()]);
    const checked = expect(a.send("slow")).rejects.toMatchObject({ name: "AbortError" });
    await until(() => events.includes("start:slow"));
    const next = b.send("remember:B");
    await a.close();
    await checked;
    expect((await next).response).toBe("B");
  });

  it("unblocks other tasks even if the adapter ignores cancellation", async () => {
    const [a, b] = await Promise.all([open(), open()]);
    const checked = expect(a.send("uncooperative")).rejects.toMatchObject({ name: "AbortError" });
    await until(() => events.includes("start:uncooperative"));
    const next = b.send("remember:B");
    await a.close();
    await checked;
    expect((await next).response).toBe("B");
    expect(events).not.toContain("end:uncooperative");
    await until(() => events.includes("end:uncooperative"));
  });

  it("rejects in-flight work on broker disconnect without resending", async () => {
    const a = await open();
    const checked = expect(a.send("slow")).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
    await until(() => events.includes("start:slow"));
    await broker.close();
    await checked;
    expect(events.filter((e) => e === "start:slow")).toHaveLength(1);
  });

  it("disconnects stale sessions when the browser itself closes", async () => {
    const a = await open();
    crashBrowser();
    await broker.closed;
    await expect(a.isLoggedIn()).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
  });

  it("releases the browser after the last client leaves", async () => {
    const a = await open();
    await a.close();
    await broker.closed;
    expect(closedContext).toBe(true);
  });
});
