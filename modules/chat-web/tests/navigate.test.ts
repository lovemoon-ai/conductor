import { describe, expect, it } from "vitest";

import {
  gotoOrThrowNetworkError,
  gotoWithRetry,
  isTransientNavigationError,
} from "../src/core/navigate.js";

describe("isTransientNavigationError", () => {
  it("recognises Chromium's net::ERR_TIMED_OUT / ERR_CONNECTION_CLOSED family", () => {
    expect(isTransientNavigationError(new Error("page.goto: net::ERR_TIMED_OUT at https://x"))).toBe(true);
    expect(isTransientNavigationError(new Error("net::ERR_CONNECTION_CLOSED"))).toBe(true);
    expect(isTransientNavigationError(new Error("net::ERR_CONNECTION_RESET"))).toBe(true);
    expect(isTransientNavigationError(new Error("net::ERR_ABORTED"))).toBe(true);
    expect(isTransientNavigationError(new Error("net::ERR_NETWORK_CHANGED"))).toBe(true);
  });

  it("recognises Playwright's plain timeout wording", () => {
    expect(isTransientNavigationError(new Error("page.goto: Timeout 30000ms exceeded."))).toBe(true);
    expect(isTransientNavigationError(new Error("Navigation timeout of 30000 ms exceeded"))).toBe(true);
  });

  it("does NOT retry permanent failures", () => {
    // DNS not found / TLS cert / actively blocked → no point retrying.
    expect(isTransientNavigationError(new Error("net::ERR_NAME_NOT_RESOLVED"))).toBe(false);
    expect(isTransientNavigationError(new Error("net::ERR_CERT_AUTHORITY_INVALID"))).toBe(false);
    expect(isTransientNavigationError(new Error("net::ERR_BLOCKED_BY_CLIENT"))).toBe(false);
  });

  it("ignores empty / nullish errors", () => {
    expect(isTransientNavigationError(undefined)).toBe(false);
    expect(isTransientNavigationError(null)).toBe(false);
    expect(isTransientNavigationError({ message: "" })).toBe(false);
    expect(isTransientNavigationError("plain string")).toBe(false);
  });
});

/**
 * Drive gotoWithRetry via a stub `page` so we can deterministically
 * inject success on the Nth attempt without a real browser.
 */
function stubPage(scenario: Array<"ok" | Error>): import("playwright").Page {
  let i = 0;
  return {
    async goto() {
      const step = scenario[i++];
      if (step === "ok") return null as unknown as never;
      throw step;
    },
  } as unknown as import("playwright").Page;
}

const silentLogger = {
  level: "silent" as const,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};

describe("gotoWithRetry", () => {
  it("returns immediately when the first attempt succeeds", async () => {
    const page = stubPage(["ok"]);
    await gotoWithRetry(page, "https://example.com", { logger: silentLogger });
  });

  it("retries on transient errors and succeeds on a later attempt", async () => {
    const page = stubPage([
      new Error("page.goto: net::ERR_TIMED_OUT at https://x"),
      new Error("net::ERR_CONNECTION_CLOSED"),
      "ok",
    ]);
    await gotoWithRetry(page, "https://example.com", {
      logger: silentLogger,
      backoffMs: 1, // make tests fast
      attempts: 3,
    });
  });

  it("rethrows the last error after all attempts are exhausted", async () => {
    const lastErr = new Error("net::ERR_TIMED_OUT (final)");
    const page = stubPage([
      new Error("net::ERR_TIMED_OUT (1st)"),
      new Error("net::ERR_TIMED_OUT (2nd)"),
      lastErr,
    ]);
    await expect(
      gotoWithRetry(page, "https://x", { logger: silentLogger, backoffMs: 1, attempts: 3 }),
    ).rejects.toBe(lastErr);
  });

  it("bails immediately on a non-transient error (e.g. DNS not found)", async () => {
    const permErr = new Error("net::ERR_NAME_NOT_RESOLVED");
    const page = stubPage([permErr, "ok", "ok"]);
    await expect(
      gotoWithRetry(page, "https://x", { logger: silentLogger, backoffMs: 1 }),
    ).rejects.toBe(permErr);
  });

  it("honours AbortSignal between attempts", async () => {
    const controller = new AbortController();
    const page = stubPage([
      new Error("net::ERR_TIMED_OUT"),
      "ok",
    ]);
    controller.abort();
    await expect(
      gotoWithRetry(page, "https://x", {
        signal: controller.signal,
        logger: silentLogger,
        backoffMs: 1,
      }),
    ).rejects.toThrow(/Aborted/);
  });
});

describe("gotoOrThrowNetworkError", () => {
  it("wraps a transient final failure into a ChatWebError with actionable hint", async () => {
    const page = stubPage([
      new Error("net::ERR_TIMED_OUT"),
      new Error("net::ERR_TIMED_OUT"),
      new Error("net::ERR_TIMED_OUT"),
    ]);
    await expect(
      gotoOrThrowNetworkError(page, "https://gemini.google.com/app", "gemini", {
        logger: silentLogger,
        backoffMs: 1,
        attempts: 3,
      }),
    ).rejects.toMatchObject({
      code: "BROWSER_LAUNCH_FAILED",
      provider: "gemini",
      hint: expect.stringMatching(/DPI|proxy|TLS|fingerprint/i),
    });
  });

  it("passes through non-transient errors verbatim", async () => {
    const dnsErr = new Error("net::ERR_NAME_NOT_RESOLVED");
    const page = stubPage([dnsErr]);
    await expect(
      gotoOrThrowNetworkError(page, "https://example.com", "x", {
        logger: silentLogger,
        backoffMs: 1,
      }),
    ).rejects.toBe(dnsErr);
  });
});
