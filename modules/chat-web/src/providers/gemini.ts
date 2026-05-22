import type { Locator, Page } from "playwright";

import {
  InputNotFoundError,
  ResponseExtractionError,
  ResponseTimeoutError,
} from "../core/errors.js";
import { typeMultiline } from "../core/keyboard.js";
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
      // AI Studio's composer is `<ms-prompt-box>` wrapping a textarea with
      // aria-label="Enter a prompt" and a CSS placeholder. The textarea is
      // the real input; there is no fallback layer like ChatGPT.
      page.locator('ms-prompt-box textarea').first(),
      page.locator('textarea[aria-label="Enter a prompt"]').first(),
      page.locator('textarea[aria-label*="prompt" i]').first(),
      page.locator('textarea[placeholder*="Start typing" i]').first(),
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
    // The Run button on AI Studio has NO aria-label — only the visible
    // text "Run" plus two Material icon font ligatures
    // ("keyboard_command_key keyboard_return"). It's a type=submit button.
    const candidates: Locator[] = [
      page.getByRole("button", { name: /^Run$/i }).first(),
      page.locator('ms-prompt-box button[type="submit"]').first(),
      page.locator('button[type="submit"]').first(),
      page.locator('button[aria-label*="Run" i]').first(),
      page.locator('button[aria-label*="Send" i]').first(),
      // Last-ditch: any button inside the composer with text containing "Run".
      page.locator('ms-prompt-box button:has-text("Run")').first(),
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

    // CRITICAL: do NOT use `locator.fill()`. AI Studio's Angular form
    // listens for `input` events to toggle the Run button between
    // disabled/enabled. `fill()` programmatically sets the textarea value
    // without firing the same event sequence Angular expects, leaving
    // the Run button stuck on disabled. Typing via keyboard fires real
    // events and Angular flips the button correctly.
    //
    // Use `typeMultiline` rather than `page.keyboard.type(message)` so
    // multi-line prompts don't submit on every `\n`: AI Studio binds
    // Cmd/Ctrl+Enter to Run, but plain Enter still inserts a newline
    // here, so a bare Enter wouldn't submit — BUT we want behaviour
    // consistent with ChatGPT, and the Shift+Enter form is universally
    // safe on every modern chat composer we've seen.
    await typeMultiline(page, message);

    // Give Angular a beat to run change detection and enable Run.
    await sleep(200);

    const send = await this.findSendButton(page);
    if (send && (await send.isEnabled().catch(() => false))) {
      await send.click().catch(async () => {
        await this.pressRunShortcut(page);
      });
    } else {
      // Fall back to the Cmd/Ctrl+Enter shortcut AI Studio binds to Run.
      await this.pressRunShortcut(page);
    }
  }

  async extractLastAssistantMessage(page: Page): Promise<string> {
    // AI Studio shape (2026-05):
    //   <ms-chat-turn>
    //     <div class="chat-turn-container ... model render">
    //       <div class="actions-container">…</div>
    //       <div class="turn-content">…actual text + chrome…</div>
    //     </div>
    //   </ms-chat-turn>
    // We target the model turn's `.turn-content`, then strip the
    // "Model HH:MM AM/PM" header and Material icon font ligatures that
    // leak into innerText (icon glyphs render as words like "edit",
    // "more_vert", "error", "content_copy", ...).
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

/**
 * Strip the UI chrome that leaks into `innerText` on AI Studio model turns.
 *
 * Observed shape after innerText:
 *
 *   Model 5:54 PM
 *   error
 *   An internal error has occurred.
 *
 * That is — a header line "Model HH:MM AM/PM" (turn role + timestamp),
 * one or more Material icon font ligatures rendered as plain text words
 * (e.g. "error", "edit", "more_vert", "content_copy"), then the actual
 * content. We drop the header and any line that is exactly a single
 * known icon ligature, then re-trim.
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
