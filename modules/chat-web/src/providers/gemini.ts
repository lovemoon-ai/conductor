import type { Locator, Page } from "playwright";

import {
  InputNotFoundError,
  ResponseExtractionError,
  ResponseTimeoutError,
} from "../core/errors.js";
import { typeMultiline } from "../core/keyboard.js";
import { gotoOrThrowNetworkError } from "../core/navigate.js";
import type { ChatProvider, ProviderDiagnostics, WaitOptions } from "../core/provider.js";
import { sleep, waitUntilStable } from "../core/response-watcher.js";

/**
 * Google Gemini (gemini.google.com) consumer chat provider adapter.
 *
 * Why gemini.google.com and not aistudio.google.com? AI Studio is the
 * developer playground and requires an API key per request — that's a
 * separate operational model. chat-web is a consumer-chat automation
 * runtime in the same league as ChatGPT (chatgpt.com), so the right
 * Gemini surface is the consumer chat at gemini.google.com, which is
 * free with a Google login and matches our persistent-profile design.
 *
 * Observed structure (2026-05):
 *   - Composer: `<rich-textarea>` wrapping a Quill editor
 *     (`div[role="textbox"][contenteditable="true"].ql-editor`).
 *     `aria-label="Enter a prompt for Gemini"`,
 *     `data-placeholder="Ask Gemini"`.
 *   - Send button: `<button aria-label="Send message">`.
 *   - Stop / streaming: `<button aria-label="Stop response">` while
 *     the model is generating.
 *   - Assistant message: `<message-content>` custom element; clean
 *     text without "Gemini said" / "edit" / "more_vert" chrome.
 *     Equivalent: `.model-response-text`, `.markdown`.
 *   - Conversation id: URL becomes
 *     `https://gemini.google.com/app/{conversation-id}` after the first
 *     turn — same pattern as ChatGPT's `/c/{uuid}` (but the id is
 *     usually a 16-hex-char string, not a UUID).
 */
export class GeminiAdapter implements ChatProvider {
  readonly name = "gemini";
  readonly homeUrl = "https://gemini.google.com/app";

  async open(page: Page): Promise<void> {
    // gotoWithRetry uses waitUntil:"commit" + exponential-backoff retries.
    // gemini.google.com is heavier than chatgpt.com (Firebase, GStatic,
    // fonts, analytics) and waiting on `load` blows the budget on slow
    // / DPI-proxied networks. The composer wait below is the real
    // readiness check.
    await gotoOrThrowNetworkError(page, this.homeUrl, this.name);
    await this.waitForComposerReady(page).catch(() => undefined);
    // Best-effort: dismiss any promo / "what's new" overlay that intercepts
    // pointer events on the composer.
    await this.dismissOverlays(page).catch(() => undefined);
  }

  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes("accounts.google.com") || url.includes("/signin/")) return false;
    // Signed-in users always see the Quill composer.
    const candidates = [
      'div[role="textbox"][contenteditable="true"][aria-label*="Gemini" i]',
      'rich-textarea div[role="textbox"]',
      'div[role="textbox"][contenteditable="true"]',
    ];
    for (const sel of candidates) {
      const visible = await page.locator(sel).first().isVisible().catch(() => false);
      if (visible) return true;
    }
    return false;
  }

  async findInput(page: Page): Promise<Locator> {
    const candidates: Locator[] = [
      page
        .locator('rich-textarea div[role="textbox"][contenteditable="true"]')
        .first(),
      page
        .locator('div[role="textbox"][contenteditable="true"][aria-label*="Gemini" i]')
        .first(),
      page.locator('div[role="textbox"][contenteditable="true"]').first(),
      page.locator('.ql-editor[contenteditable="true"]').first(),
    ];
    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    throw new InputNotFoundError(this.name);
  }

  async findSendButton(page: Page): Promise<Locator | null> {
    const candidates: Locator[] = [
      page.locator('button[aria-label="Send message"]').first(),
      page.locator('button[aria-label*="Send message" i]').first(),
      page.locator('button[aria-label*="发送" i]').first(),
    ];
    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    return null;
  }

  async sendMessage(page: Page, message: string): Promise<void> {
    const input = await this.findInput(page);

    // The Quill editor (`.ql-editor`) listens for real key events to
    // toggle the Send button between disabled/enabled. `locator.fill`
    // is a no-op on contenteditable, and stuck overlays sometimes
    // intercept normal clicks — `{ force: true }` is necessary even
    // when the input itself is visible.
    await input.click({ force: true });
    await input.focus().catch(() => undefined);
    await typeMultiline(page, message);
    await sleep(150);

    const send = await this.findSendButton(page);
    if (send && (await send.isEnabled().catch(() => false))) {
      await send.click({ force: true }).catch(async () => {
        // Enter is "submit" in the Gemini composer too; Shift+Enter is
        // the soft line break that typeMultiline already used between
        // segments, so a bare Enter at the end is safe.
        await page.keyboard.press("Enter");
      });
    } else {
      await page.keyboard.press("Enter");
    }
  }

  async extractLastAssistantMessage(page: Page): Promise<string> {
    // `<message-content>` is Gemini's clean per-turn container — no
    // "Gemini said" chrome, no copy/feedback icon ligatures. Prefer it
    // and fall back to `.model-response-text` / `.markdown` if the
    // custom element ever gets renamed.
    const candidates: Locator[] = [
      page.locator("message-content").last(),
      page.locator(".model-response-text").last(),
      page.locator("model-response .markdown").last(),
      page.locator("model-response").last(),
    ];

    for (const locator of candidates) {
      if (await locator.count().then((n) => n > 0).catch(() => false)) {
        const raw = await locator.innerText().catch(() => "");
        // <model-response> includes a "Gemini said" prefix; strip it.
        const cleaned = raw.replace(/^Gemini said\s*/i, "").trim();
        if (cleaned) return cleaned;
      }
    }

    throw new ResponseExtractionError(this.name);
  }

  async waitForResponse(page: Page, options: WaitOptions = {}): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const stableMs = options.stableMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;

    // Phase 1: wait for the stop button (streaming started).
    await this.waitForStopButton(page, { timeoutMs: 15_000 }).catch(() => undefined);

    // Phase 2: stop button disappears (streaming ended).
    const remaining = Math.max(deadline - Date.now(), 5_000);
    await this.waitForStopButtonGone(page, remaining).catch(() => undefined);

    // Phase 3: text-stability backstop.
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
    return stable;
  }

  /**
   * Conversation id from `gemini.google.com/app/{id}`. Gemini's id is
   * typically a 16-hex-char string (e.g. "372437d29c30422f"), not a
   * UUID — the regex accepts both shapes.
   */
  getConversationId(page: Page): string | null {
    const url = page.url();
    const match = url.match(/\/app\/([0-9a-fA-F-]{8,})/);
    return match ? match[1]! : null;
  }

  async newChat(page: Page): Promise<void> {
    const candidates: Locator[] = [
      page.getByRole("button", { name: /new chat|新对话|新建对话/i }).first(),
      page.getByRole("link", { name: /new chat|新对话/i }).first(),
      page.locator('a[href$="/app"]').first(),
    ];
    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) {
        await locator.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(800);
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
      .locator("message-content")
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

  /** Dismiss any "What's new" / promo overlay covering the composer. */
  private async dismissOverlays(page: Page): Promise<void> {
    const closers = [
      '.cdk-overlay-container button[aria-label*="close" i]',
      '.cdk-overlay-container button[aria-label*="dismiss" i]',
      '.cdk-overlay-container button[aria-label*="not now" i]',
      '.cdk-overlay-container button[aria-label*="maybe later" i]',
    ];
    for (const sel of closers) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ force: true }).catch(() => undefined);
        await sleep(300);
      }
    }
    // Belt-and-braces: press Escape so any uncloseable popover dismisses.
    await page.keyboard.press("Escape").catch(() => undefined);
  }

  private async waitForComposerReady(page: Page, timeoutMs = 15_000): Promise<void> {
    const sel =
      'rich-textarea div[role="textbox"][contenteditable="true"], div[role="textbox"][contenteditable="true"][aria-label*="Gemini" i]';
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
      'button[aria-label="Stop response"]',
      'button[aria-label*="Stop response" i]',
      'button[aria-label*="Stop generating" i]',
      'button[aria-label*="停止" i]',
    ];
    for (const sel of selectors) {
      const visible = await page.locator(sel).first().isVisible().catch(() => false);
      if (visible) return true;
    }
    return false;
  }
}

/**
 * Backwards-compat export for tests / callers that still import the
 * AI-Studio-era chrome-stripping helper. The new gemini.google.com
 * `<message-content>` doesn't ship the "Model HH:MM AM/PM" header or
 * Material icon ligatures, so the only chrome we still strip is the
 * "Gemini said" prefix that `<model-response>` wraps around content.
 * Exported for the unit test in tests/gemini.test.ts.
 */
export function stripChromeFromTurn(text: string): string {
  if (!text) return "";
  return text.replace(/^Gemini said\s*/i, "").trim();
}
