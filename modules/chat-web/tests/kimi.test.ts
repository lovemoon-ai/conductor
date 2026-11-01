import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KimiAdapter } from "../src/providers/kimi.js";

function harness() {
  const state = {
    loggedIn: true, loginRequired: false, captcha: false, busy: false, userCount: 0,
    assistants: [] as { text: string; error: string; pending: boolean; afterLastUser: boolean }[],
  };
  const fill = vi.fn().mockResolvedValue(undefined);
  const click = vi.fn().mockResolvedValue(undefined);
  const locator = {
    first() { return this; }, isVisible: vi.fn().mockResolvedValue(true),
    waitFor: vi.fn().mockResolvedValue(undefined), fill, click,
  };
  const page = {
    evaluate: vi.fn(async () => state),
    locator: vi.fn(() => locator),
    url: () => "https://www.kimi.com/chat/current-chat",
  } as unknown as Page;
  const reply = (text: string) => {
    state.userCount += 1;
    state.assistants.push({ text, error: "", pending: false, afterLastUser: true });
  };
  return { page, state, fill, click, reply, adapter: new KimiAdapter() };
}

afterEach(() => vi.useRealTimers());

describe("KimiAdapter turns", () => {
  it("rejects the signed-out composer before submitting anything", async () => {
    const h = harness();
    h.state.loggedIn = false;
    await expect(h.adapter.sendMessage(h.page, "hi")).rejects.toMatchObject({ code: "NOT_LOGGED_IN" });
    expect(h.fill).not.toHaveBeenCalled();
    expect(h.click).not.toHaveBeenCalled();
  });

  it("fills literal multiline text and submits exactly once", async () => {
    const h = harness();
    await h.adapter.sendMessage(h.page, "first\nsecond");
    expect(h.fill).toHaveBeenCalledWith("first\nsecond");
    expect(h.click).toHaveBeenCalledTimes(1);
    await expect(h.adapter.sendMessage(h.page, "duplicate")).rejects.toMatchObject({ code: "SELECTOR_VERIFICATION" });
  });

  it("does not resend after a failed click whose submission is uncertain", async () => {
    const h = harness();
    h.click.mockRejectedValueOnce(new Error("page disconnected"));
    await expect(h.adapter.sendMessage(h.page, "hi")).rejects.toThrow("page disconnected");
    expect(h.click).toHaveBeenCalledTimes(1);
    await h.adapter.sendMessage(h.page, "retry explicitly");
  });

  it("waits for the second turn even when the old and new answers are identical", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.reply("42");
    await h.adapter.sendMessage(h.page, "repeat that");
    const progress = vi.fn();
    const pending = h.adapter.waitForResponse(h.page, { stableMs: 100, timeoutMs: 5000, onProgress: progress });
    await vi.advanceTimersByTimeAsync(1500);
    expect(progress).not.toHaveBeenCalled();
    h.reply("42");
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe("42");
    expect(progress).toHaveBeenCalledWith("42");
    await h.adapter.sendMessage(h.page, "third turn");
  });

  it("does not finish while generation pauses or an assistant is pending", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.adapter.sendMessage(h.page, "think carefully");
    h.reply("partial");
    h.state.busy = true;
    const pending = h.adapter.waitForResponse(h.page, { stableMs: 100, timeoutMs: 10000 });
    let done = false;
    void pending.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(2000);
    expect(done).toBe(false);
    h.state.busy = false;
    h.state.assistants[0]!.pending = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(false);
    h.state.assistants[0]!.pending = false;
    h.state.assistants[0]!.text = "complete";
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe("complete");
  });

  it("times out with a partial response instead of reporting success", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.adapter.sendMessage(h.page, "long response");
    h.reply("partial");
    h.state.busy = true;
    const checked = expect(h.adapter.waitForResponse(h.page, { timeoutMs: 1000, stableMs: 100 }))
      .rejects.toMatchObject({ code: "RESPONSE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1000);
    await checked;
    h.state.busy = false;
    await h.adapter.sendMessage(h.page, "next");
  });

  it.each([
    ["loginRequired", "NOT_LOGGED_IN"], ["captcha", "PROVIDER_CAPTCHA"],
  ] as const)("reports %s during a turn", async (key, code) => {
    const h = harness();
    await h.adapter.sendMessage(h.page, "hello");
    h.state[key] = true;
    await expect(h.adapter.waitForResponse(h.page)).rejects.toMatchObject({ code });
  });

  it.each([
    ["Too many requests", "PROVIDER_RATE_LIMITED"], ["Something went wrong", "RESPONSE_EXTRACTION"],
  ])("does not treat a provider error as assistant output: %s", async (message, code) => {
    const h = harness();
    await h.adapter.sendMessage(h.page, "hi");
    h.reply("");
    h.state.assistants[0]!.error = message!;
    await expect(h.adapter.waitForResponse(h.page)).rejects.toMatchObject({ code });
  });

  it("honours cancellation and clears the pending turn", async () => {
    const h = harness();
    await h.adapter.sendMessage(h.page, "hi");
    const controller = new AbortController();
    controller.abort();
    await expect(h.adapter.waitForResponse(h.page, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    await h.adapter.sendMessage(h.page, "next");
  });

  it("refuses to return arbitrary old text without a pending turn", async () => {
    const h = harness();
    h.reply("old reply");
    await expect(h.adapter.waitForResponse(h.page)).rejects.toMatchObject({ code: "RESPONSE_EXTRACTION" });
  });
});

describe("KimiAdapter conversation URLs", () => {
  const adapter = new KimiAdapter();
  it.each([
    ["https://www.kimi.com/chat/c123_ab-1?chat_enter_method=history", "c123_ab-1"],
    ["https://kimi.com/chat/c123/", "c123"],
    ["https://www.kimi.com/", null],
    ["https://www.kimi.com/share/c123", null],
    ["https://other.example/chat/c123", null],
    ["not a URL", null],
  ])("parses %s", (url, expected) => {
    expect(adapter.getConversationId({ url: () => url } as Page)).toBe(expected);
  });
});
