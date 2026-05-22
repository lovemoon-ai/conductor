import type { Locator, Page } from "playwright";

import {
  InputNotFoundError,
  ResponseExtractionError,
  ResponseTimeoutError,
} from "../core/errors.js";
import type { ChatProvider, ProviderDiagnostics, WaitOptions } from "../core/provider.js";
import { sleep, waitUntilStable } from "../core/response-watcher.js";

/**
 * Google AI Studio (aistudio.google.com) provider adapter.
 *
 * AI Studio is an Angular Material app — composer is a textarea inside a
 * `<ms-prompt-input>` custom element, the submit button carries either a
 * "Run" / "Send" aria-label or a play icon, and assistant turns render
 * inside `<ms-chat-turn>` / `<ms-prompt-chunk>` custom elements.
 *
 * Like DeepSeek, the streaming response goes through Google's own RPC
 * format (not SSE-compatible with our `ChatGPTSSECollector`), so this
 * adapter uses DOM `innerText` extraction gated by a stop-button toggle.
 * Markdown structure on text + code is preserved by AI Studio's renderer
 * for the most common cases (code blocks are real `<pre>` text), but
 * bullets / table pipes may be lost — same caveat as DeepSeek today.
 */
export class GeminiAdapter implements ChatProvider {
  readonly name = "gemini";
  readonly homeUrl = "https://aistudio.google.com/prompts/new_chat?model=gemini-3.5-flash";

  async open(page: Page): Promise<void> {
    await page.goto(this.homeUrl, { waitUntil: "domcontentloaded" }).catch(() => {
      return page.goto(this.homeUrl, { waitUntil: "load", timeout: 30_000 });
    });
    // AI Studio's Angular shell hydrates after DCL; give the composer a
    // moment to attach before any subsequent action races it.
    await this.waitForComposerReady(page).catch(() => undefined);
  }

  async isLoggedIn(page: Page): Promise<boolean> {
    // Signed-out users land on accounts.google.com. Signed-in users see
    // the prompt textarea. Detect by URL pattern first, then DOM.
    const url = page.url();
    if (url.includes("accounts.google.com") || url.includes("/signin/")) return false;
    const candidates = [
      'ms-prompt-input textarea',
      'textarea[aria-label*="prompt" i]',
      'textarea[aria-label*="Type something" i]',
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
      page.locator('ms-prompt-input textarea').first(),
      page.locator('textarea[aria-label*="prompt" i]').first(),
      page.locator('textarea[placeholder*="Type something" i]').first(),
      page.locator('textarea[aria-label*="Type something" i]').first(),
      page.locator('div[contenteditable="true"]').first(),
      page.locator('textarea').first(),
    ];

    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
    throw new InputNotFoundError(this.name);
  }

  async findSendButton(page: Page): Promise<Locator | null> {
    const candidates: Locator[] = [
      page.locator('button[aria-label="Run"]').first(),
      page.locator('button[aria-label*="Run" i]').first(),
      page.locator('button[aria-label*="Send" i]').first(),
      page.locator('button[type="submit"]').first(),
      // AI Studio sometimes renders the submit as a circular icon button
      // next to the composer — anchor by proximity to the textarea form.
      page.locator('ms-prompt-input button').last(),
    ];

    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
    return null;
  }

  async sendMessage(page: Page, message: string): Promise<void> {
    const input = await this.findInput(page);
    await input.click();

    // AI Studio's textarea accepts both `fill` (for plain text) and
    // keyboard insertText; prefer `fill` which clears any placeholder
    // formatting reliably, fall back to insertText if Angular intercepts.
    const filled = await input.fill(message).then(
      () => true,
      () => false,
    );
    if (!filled) {
      await page.keyboard.insertText(message);
    }

    // AI Studio binds Cmd/Ctrl+Enter as the "Run" shortcut. Using the
    // keyboard avoids races with the form's click handlers that sometimes
    // gate the visible "Run" button on a debounced focus check.
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
      // AI Studio wraps each turn in <ms-chat-turn>; the model turn carries
      // a role attribute or class. Try several selectors so we don't have
      // to guess the exact internal name.
      page.locator('ms-chat-turn[data-turn-role="model"] ms-prompt-chunk').last(),
      page.locator('ms-chat-turn').last(),
      page.locator('[data-turn-role="model"]').last(),
      page.locator('ms-prompt-chunk').last(),
      page.locator('.markdown, .prose, .model-response').last(),
      page.locator('main article').last(),
    ];

    for (const locator of candidates) {
      if (await locator.count().then((n) => n > 0).catch(() => false)) {
        const text = await locator.innerText().catch(() => "");
        if (text && text.trim()) return text.trim();
      }
    }

    throw new ResponseExtractionError(this.name);
  }

  async waitForResponse(page: Page, options: WaitOptions = {}): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const stableMs = options.stableMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;

    // Phase 1: wait for streaming to begin (stop button appears).
    await this.waitForStopButton(page, { timeoutMs: 15_000 }).catch(() => undefined);

    // Phase 2: wait for streaming to end.
    const remaining = Math.max(deadline - Date.now(), 5_000);
    await this.waitForStopButtonGone(page, remaining).catch(() => undefined);

    // Phase 3: text stability backstop.
    const stable = await waitUntilStable(
      () => this.extractLastAssistantMessage(page).catch(() => ""),
      {
        timeoutMs: Math.max(deadline - Date.now(), 1_500),
        stableMs,
        signal: options.signal,
        onProgress: options.onProgress,
      },
    );

    if (!stable) {
      throw new ResponseTimeoutError(this.name, timeoutMs);
    }
    return stable;
  }

  async newChat(page: Page): Promise<void> {
    const candidates: Locator[] = [
      page.getByRole("button", { name: /new chat|新对话|新建对话/i }).first(),
      page.getByRole("link", { name: /new chat|新对话/i }).first(),
      page.locator('a[href*="/prompts/new_chat"]').first(),
    ];

    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) {
        await locator.click().catch(() => undefined);
        return;
      }
    }
    // Fallback: navigate directly to a fresh chat URL.
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
      .locator('ms-chat-turn, ms-prompt-chunk')
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

  private async waitForComposerReady(page: Page, timeoutMs = 15_000): Promise<void> {
    const sel =
      'ms-prompt-input textarea, textarea[aria-label*="prompt" i], textarea[placeholder*="Type something" i], textarea';
    await page.locator(sel).first().waitFor({ state: "visible", timeout: timeoutMs });
  }

  private async pressRunShortcut(page: Page): Promise<void> {
    // AI Studio binds Cmd/Ctrl+Enter to "Run". Use the platform-appropriate
    // modifier so headless runs on Linux/macOS both work.
    const isMac = process.platform === "darwin";
    await page.keyboard.press(isMac ? "Meta+Enter" : "Control+Enter");
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
