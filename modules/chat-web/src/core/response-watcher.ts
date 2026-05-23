import type { Page } from "playwright";

export interface WaitUntilStableOptions {
  /** How long the text must stop changing before we consider it stable. Default 2000ms. */
  stableMs?: number;
  /** Hard upper bound. Default 120_000ms. */
  timeoutMs?: number;
  /** Poll interval between samples. Default 300ms. */
  pollIntervalMs?: number;
  /** AbortSignal so callers can cancel the wait. */
  signal?: AbortSignal;
  /** Optional callback whenever the sampled text grows (useful for progress UI). */
  onProgress?: (text: string) => void;
}

/**
 * Watch a streaming source (typically the last assistant message) until its
 * text stops mutating for `stableMs` consecutive milliseconds, or the
 * `timeoutMs` budget is exhausted.
 *
 * `getText` should return "" (or throw) while the message doesn't exist yet;
 * we treat both cases the same and keep polling.
 *
 * RFC §10 — also recommends combining this with "stop button vanished"
 * and "send button re-enabled"; those checks live in the provider adapters
 * because the selectors are provider-specific.
 */
export async function waitUntilStable(
  getText: () => Promise<string>,
  options: WaitUntilStableOptions = {},
): Promise<string> {
  const stableMs = options.stableMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 300;

  const deadline = Date.now() + timeoutMs;
  let last = "";
  let stableSince = Date.now();
  let everSeen = false;

  while (true) {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    let current = "";
    try {
      current = await getText();
    } catch {
      current = "";
    }

    if (current !== last) {
      last = current;
      stableSince = Date.now();
      if (current) {
        everSeen = true;
        options.onProgress?.(current);
      }
    }

    const sinceChange = Date.now() - stableSince;
    if (everSeen && sinceChange >= stableMs) {
      return last;
    }

    if (Date.now() > deadline) {
      // Return whatever we have rather than throwing — the caller (provider
      // adapter or `ask` flow) decides whether to error or surface partial.
      return last;
    }

    await sleep(pollIntervalMs);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convenience: wait until the assistant message count grows past a baseline.
 * Useful right after pressing Enter, so we know the streaming has started.
 */
export async function waitForResponseStart(
  page: Page,
  selector: string,
  baseline: number,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > baseline) return;
    await sleep(pollIntervalMs);
  }
}
