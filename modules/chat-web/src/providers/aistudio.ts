import type { Locator, Page } from "playwright";

import {
  InputNotFoundError,
  ProviderApiKeyRequiredError,
  ProviderPermissionDeniedError,
  ResponseExtractionError,
  ResponseTimeoutError,
} from "../core/errors.js";
import { typeMultiline } from "../core/keyboard.js";
import { gotoOrThrowNetworkError } from "../core/navigate.js";
import type { ChatProvider, ProviderDiagnostics, WaitOptions } from "../core/provider.js";
import { sleep, waitUntilStable } from "../core/response-watcher.js";

/**
 * Google AI Studio (aistudio.google.com) provider adapter — sibling of
 * {@link GeminiAdapter}.
 *
 * Why a separate provider? AI Studio and gemini.google.com are two
 * different products under the same brand:
 *
 *   - `gemini.google.com` (the {@link GeminiAdapter} target) is the
 *     consumer chat: free with a Google login, no API key required,
 *     mirrors the chatgpt.com persistent-profile UX.
 *   - `aistudio.google.com` (this adapter's target) is the developer
 *     playground: requires an API key per request, exposes model /
 *     temperature / system-prompt controls. Some users explicitly want
 *     this surface (e.g. they have an API key configured and want the
 *     playground's structured output / function-calling controls).
 *
 * Operationally:
 *   - Composer is `<ms-prompt-box>` (Angular Material) wrapping a
 *     textarea with `aria="Enter a prompt"`.
 *   - Run button has NO aria-label; the visible text is "Run" plus two
 *     Material icon font ligatures (`keyboard_command_key`,
 *     `keyboard_return`). It IS `type="submit"`.
 *   - Stop-generating: same `composer-submit-button` flipped to a stop
 *     glyph (`data-state=stop` or aria-label change).
 *   - Model turn: `<ms-chat-turn>` containing a `.chat-turn-container.model`
 *     with `.turn-content`. innerText includes Material icon font
 *     ligatures rendered as plain text words — strip them.
 *
 * If a turn fails (no API key, permission denied, quota exhausted), AI
 * Studio renders "An internal error has occurred." or
 * "Failed to generate content: permission denied" as the model turn
 * BODY — same as if the model had answered with that text. We detect
 * those patterns and throw typed errors (`PROVIDER_API_KEY_REQUIRED` /
 * `PROVIDER_PERMISSION_DENIED`) so callers can route them properly.
 */
export class AIStudioAdapter implements ChatProvider {
  readonly name = "aistudio";
  readonly homeUrl = "https://aistudio.google.com/prompts/new_chat";

  async open(page: Page): Promise<void> {
    await gotoOrThrowNetworkError(page, this.homeUrl, this.name);
    await this.waitForComposerReady(page).catch(() => undefined);
  }

  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes("accounts.google.com") || url.includes("/signin/")) return false;
    const candidates = [
      'ms-prompt-box textarea',
      'textarea[aria-label="Enter a prompt"]',
      'textarea[aria-label*="prompt" i]',
      'textarea',
    ];
    for (const sel of candidates) {
      const visible = await page.locator(sel).first().isVisible().catch(() => false);
      if (visible) return true;
    }
    return false;
  }

  async findInput(page: Page): Promise<Locator> {
    const candidates: Locator[] = [
      page.locator('ms-prompt-box textarea').first(),
      page.locator('textarea[aria-label="Enter a prompt"]').first(),
      page.locator('textarea[aria-label*="prompt" i]').first(),
      page.locator('textarea[placeholder*="Start typing" i]').first(),
      page.locator('textarea').first(),
    ];
    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    throw new InputNotFoundError(this.name);
  }

  async findSendButton(page: Page): Promise<Locator | null> {
    // Run button has NO aria-label — getByRole resolves the accessible
    // name from visible "Run" text, then we fall back to type=submit.
    const candidates: Locator[] = [
      page.getByRole("button", { name: /^Run$/i }).first(),
      page.locator('ms-prompt-box button[type="submit"]').first(),
      page.locator('button[type="submit"]').first(),
      page.locator('ms-prompt-box button:has-text("Run")').first(),
    ];
    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    return null;
  }

  async sendMessage(page: Page, message: string): Promise<void> {
    const input = await this.findInput(page);
    await input.click();
    // typeMultiline preserves newlines correctly. Angular Material's
    // form state requires real input events (locator.fill() leaves Run
    // disabled forever), and the editor treats bare Enter as submit.
    await typeMultiline(page, message);
    await sleep(200);

    const send = await this.findSendButton(page);
    if (send && (await send.isEnabled().catch(() => false))) {
      await send.click().catch(async () => {
        await this.pressRunShortcut(page);
      });
    } else {
      await this.pressRunShortcut(page);
    }
  }

  async extractLastAssistantMessage(page: Page): Promise<string> {
    const candidates: Locator[] = [
      page.locator('ms-chat-turn .chat-turn-container.model .turn-content').last(),
      page.locator('.chat-turn-container.model .turn-content').last(),
      page.locator('ms-chat-turn .turn-content').last(),
      page.locator('ms-chat-turn').last(),
    ];
    for (const locator of candidates) {
      if (await locator.count().then((n) => n > 0).catch(() => false)) {
        const raw = await locator.innerText().catch(() => "");
        const cleaned = stripChromeFromTurn(raw);
        if (cleaned) return cleaned;
      }
    }
    throw new ResponseExtractionError(this.name);
  }

  async waitForResponse(page: Page, options: WaitOptions = {}): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const stableMs = options.stableMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;

    await this.waitForStopButton(page, { timeoutMs: 15_000 }).catch(() => undefined);
    const remaining = Math.max(deadline - Date.now(), 5_000);
    await this.waitForStopButtonGone(page, remaining).catch(() => undefined);

    const stable = await waitUntilStable(
      () => this.extractLastAssistantMessage(page).catch(() => ""),
      {
        timeoutMs: Math.max(deadline - Date.now(), 1_500),
        stableMs,
        signal: options.signal,
        onProgress: options.onProgress,
      },
    );
    if (!stable) throw new ResponseTimeoutError(this.name, timeoutMs);

    // Detect upstream failures rendered as the model turn body.
    await this.throwIfKnownUpstreamError(page, stable);
    return stable;
  }

  /**
   * AI Studio's per-prompt URL is `/prompts/{slug}` after the first
   * turn — but **only when the user has saved/published the prompt**.
   * For free-tier "scratch" prompts the URL keeps the
   * `/prompts/new_chat` segment. We return the id only when present.
   */
  getConversationId(page: Page): string | null {
    const url = page.url();
    // Match /prompts/{slug} but EXCLUDE the placeholder "new_chat".
    const match = url.match(/\/prompts\/([^/?#]+)/);
    if (!match) return null;
    const slug = match[1]!;
    if (slug === "new_chat" || slug === "") return null;
    return slug;
  }

  async newChat(page: Page): Promise<void> {
    const candidates: Locator[] = [
      page.getByRole("button", { name: /new (chat|prompt)|新对话|新建对话/i }).first(),
      page.getByRole("link", { name: /new (chat|prompt)|新对话/i }).first(),
      page.locator('a[href*="/prompts/new_chat"]').first(),
    ];
    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) {
        await locator.click().catch(() => undefined);
        await page.waitForTimeout(500);
        return;
      }
    }
    await this.open(page);
  }

  async diagnose(page: Page): Promise<ProviderDiagnostics> {
    const [loggedIn, sendBtn] = await Promise.all([
      this.isLoggedIn(page),
      this.findSendButton(page).then((l) => l !== null),
    ]);

    let inputFound = false;
    try {
      await this.findInput(page);
      inputFound = true;
    } catch {
      inputFound = false;
    }

    const assistantMessageCount = await page
      .locator("ms-chat-turn, ms-prompt-chunk")
      .count()
      .catch(() => 0);

    const stopButtonFound = await this.isStopButtonVisible(page);

    let lastAssistantLength = 0;
    try {
      const text = await this.extractLastAssistantMessage(page);
      lastAssistantLength = text.length;
    } catch {
      lastAssistantLength = 0;
    }

    return {
      loggedIn,
      inputFound,
      sendButtonFound: sendBtn,
      assistantMessageCount,
      stopButtonFound,
      lastAssistantLength,
      pageUrl: page.url(),
    };
  }

  private async throwIfKnownUpstreamError(page: Page, text: string): Promise<void> {
    const lower = text.toLowerCase();
    if (lower.includes("an internal error has occurred")) {
      const cause = await this.detectFailureCause(page);
      if (cause === "no-api-key") {
        throw new ProviderApiKeyRequiredError(
          this.name,
          'AI Studio shows "No API key selected"; configure an API key to run prompts.',
        );
      }
      throw new ProviderPermissionDeniedError(this.name, text);
    }
    if (lower.includes("failed to generate content")) {
      throw new ProviderPermissionDeniedError(this.name, text);
    }
  }

  private async detectFailureCause(
    page: Page,
  ): Promise<"no-api-key" | "permission-denied" | ""> {
    const noKey = await page
      .locator('button[aria-label="No API key selected"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (noKey) return "no-api-key";
    const found = await page
      .evaluate(() => {
        const t = (document.body.innerText || "").toLowerCase();
        if (t.includes("permission denied")) return "permission-denied";
        if (t.includes("no api key") || t.includes("get api key")) return "no-api-key";
        return "";
      })
      .catch(() => "");
    if (found === "permission-denied" || found === "no-api-key") return found;
    return "";
  }

  private async pressRunShortcut(page: Page): Promise<void> {
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+Enter" : "Control+Enter");
  }

  private async waitForComposerReady(page: Page, timeoutMs = 15_000): Promise<void> {
    const sel =
      'ms-prompt-box textarea, textarea[aria-label="Enter a prompt"], textarea[aria-label*="prompt" i], textarea';
    await page.locator(sel).first().waitFor({ state: "visible", timeout: timeoutMs });
  }

  private async waitForStopButton(
    page: Page,
    options: { timeoutMs?: number } = {},
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isStopButtonVisible(page)) return;
      await sleep(150);
    }
  }

  private async waitForStopButtonGone(page: Page, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let consecutiveGone = 0;
    while (Date.now() < deadline) {
      const visible = await this.isStopButtonVisible(page);
      if (!visible) {
        consecutiveGone += 1;
        if (consecutiveGone >= 3) return;
      } else {
        consecutiveGone = 0;
      }
      await sleep(200);
    }
  }

  private async isStopButtonVisible(page: Page): Promise<boolean> {
    const selectors = [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Cancel" i]',
      'button[aria-label*="停止" i]',
      'button[data-test-id="stop-button"]',
    ];
    for (const sel of selectors) {
      const visible = await page.locator(sel).first().isVisible().catch(() => false);
      if (visible) return true;
    }
    return false;
  }
}

/**
 * AI Studio's `innerText` on the model turn includes "Model HH:MM AM/PM"
 * headers + Material icon ligatures rendered as plain text words. Strip
 * single-line ligature matches and the turn header.
 *
 * (gemini.google.com's <message-content> doesn't have these — it has
 * its own `stripChromeFromTurn` in providers/gemini.ts that only
 * removes a leading "Gemini said".)
 */
export function stripChromeFromTurn(text: string): string {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const HEADER = /^(Model|User|System)\s+\d{1,2}:\d{2}\s*(AM|PM)?\s*$/i;
  const ICON_LIGATURES = new Set([
    "edit",
    "more_vert",
    "error",
    "content_copy",
    "thumb_up",
    "thumb_down",
    "refresh",
    "delete",
    "close",
    "expand_more",
    "expand_less",
    "code",
    "play_arrow",
    "stop",
    "menu",
  ]);
  const kept: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      kept.push(raw);
      continue;
    }
    if (HEADER.test(trimmed)) continue;
    if (ICON_LIGATURES.has(trimmed)) continue;
    kept.push(raw);
  }
  return kept.join("\n").trim();
}
