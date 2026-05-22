import type { Page } from "playwright";

import { ChatWebError } from "./errors.js";
import { defaultLogger, type Logger } from "./logger.js";

export interface GotoWithRetryOptions {
  /** Hard upper bound per attempt. Default 15_000ms. */
  timeoutMs?: number;
  /** Maximum number of attempts. Default 3. */
  attempts?: number;
  /** Base backoff between attempts, exponentially scaled. Default 1500ms. */
  backoffMs?: number;
  /**
   * Playwright `waitUntil`. Default `"commit"` — the fastest signal that
   * navigation succeeded. We deliberately do NOT wait for `load` or
   * `networkidle`: chat sites pull dozens of subresources (analytics,
   * fonts, CDNs) that block whole-page load events on slow / proxied
   * networks. The adapter waits for the specific composer locator
   * separately, which is what we actually need.
   */
  waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
  logger?: Logger;
  signal?: AbortSignal;
}

const TRANSIENT_NET_ERROR_HINTS = [
  "net::err_timed_out",
  "net::err_connection_closed",
  "net::err_connection_reset",
  "net::err_connection_aborted",
  "net::err_network_changed",
  "net::err_aborted",
  "net::err_socket_not_connected",
  "navigation timeout",
  "timeout",
];

/**
 * True when the error looks like a transient network condition worth
 * retrying. Excludes DNS-not-found and TLS cert errors — those won't
 * fix themselves on the next attempt.
 */
export function isTransientNavigationError(err: unknown): boolean {
  const msg = String((err as Error | undefined)?.message ?? "").toLowerCase();
  if (!msg) return false;
  // Don't retry permanent failures.
  if (msg.includes("net::err_name_not_resolved")) return false;
  if (msg.includes("net::err_cert_")) return false;
  if (msg.includes("net::err_blocked_by")) return false;
  return TRANSIENT_NET_ERROR_HINTS.some((hint) => msg.includes(hint));
}

/**
 * Navigate to a URL with exponential-backoff retries on transient network
 * errors. Intended for adapter `open()` where flaky proxies / unstable
 * networks frequently cause Chromium's first connection to time out
 * even when curl from the same shell works in 1–2s (a real condition
 * we see in users with DNS-rewriting boxes that DPI-fingerprint
 * Chromium's TLS handshake).
 *
 * Behaviour:
 *   - Up to `attempts` tries (default 3).
 *   - Default per-attempt timeout 15s; the *whole* operation is capped
 *     at attempts × (timeoutMs + backoff*2^i).
 *   - Only transient errors (see `isTransientNavigationError`) trigger
 *     retries. DNS / TLS-cert failures bubble up immediately.
 *   - On final failure, the last underlying error is rethrown verbatim
 *     so callers can wrap it in their own typed error with context.
 */
export async function gotoWithRetry(
  page: Page,
  url: string,
  options: GotoWithRetryOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const attempts = Math.max(1, options.attempts ?? 3);
  const backoffMs = options.backoffMs ?? 1_500;
  const waitUntil = options.waitUntil ?? "commit";
  const logger = options.logger ?? defaultLogger;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      await page.goto(url, { waitUntil, timeout: timeoutMs });
      if (attempt > 1) {
        logger.info(`chat-web: navigation to ${url} succeeded on attempt ${attempt}/${attempts}`);
      }
      return;
    } catch (err) {
      lastError = err;
      if (!isTransientNavigationError(err) || attempt === attempts) break;
      const delay = backoffMs * Math.pow(2, attempt - 1);
      logger.warn(
        `chat-web: navigation to ${url} failed (attempt ${attempt}/${attempts}): ${
          (err as Error).message?.split("\n")[0] ?? "(unknown)"
        }. Retrying in ${delay}ms…`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Re-throw the last error unchanged; callers add their own context.
  throw lastError;
}

/**
 * Convenience: navigate and wrap any failure as a {@link ChatWebError}
 * with a clear, user-actionable message. Adapters should use this
 * inside `open()` so a connectivity problem surfaces with a useful
 * hint instead of a raw `net::ERR_TIMED_OUT`.
 */
export async function gotoOrThrowNetworkError(
  page: Page,
  url: string,
  provider: string,
  options: GotoWithRetryOptions = {},
): Promise<void> {
  try {
    await gotoWithRetry(page, url, options);
  } catch (err) {
    if (isTransientNavigationError(err)) {
      const summary = String((err as Error).message ?? "").split("\n")[0];
      throw new ChatWebError(
        "BROWSER_LAUNCH_FAILED",
        `Chromium could not reach ${url} for "${provider}" (${summary}).`,
        {
          provider,
          cause: err,
          hint:
            "curl from the same shell may still work — that usually means the local proxy / DNS box is DPI-fingerprinting Chromium's TLS handshake. " +
            "Try a different proxy that supports browser traffic, switch networks, or wait for the route to stabilise.",
        },
      );
    }
    throw err;
  }
}
