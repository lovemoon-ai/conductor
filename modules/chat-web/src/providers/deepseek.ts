import type { Locator, Page } from "playwright";

import {
  InputNotFoundError,
  ResponseExtractionError,
  ResponseTimeoutError,
} from "../core/errors.js";
import type { ChatProvider, ProviderDiagnostics, WaitOptions } from "../core/provider.js";
import { sleep, waitUntilStable } from "../core/response-watcher.js";

/**
 * DeepSeek (chat.deepseek.com) provider adapter.
 *
 * Per RFC §13.2 this is a sibling of ChatGPTAdapter, not a subclass —
 * they implement the same interface but the selectors and login probes
 * are different enough that sharing logic would be a footgun.
 */
export class DeepSeekAdapter implements ChatProvider {
  readonly name = "deepseek";
  readonly homeUrl = "https://chat.deepseek.com/";

  async open(page: Page): Promise<void> {
    await page.goto(this.homeUrl, { waitUntil: "domcontentloaded" }).catch(() => {
      return page.goto(this.homeUrl, { waitUntil: "load", timeout: 30_000 });
    });
  }

  async isLoggedIn(page: Page): Promise<boolean> {
    // DeepSeek's signed-out state shows a phone/login form. The signed-in
    // state shows the chat composer (textarea) immediately.
    const composer = page
      .locator('textarea[placeholder*="DeepSeek" i], textarea[placeholder*="给 DeepSeek" i], textarea')
      .first();
    return await composer.isVisible().catch(() => false);
  }

  async findInput(page: Page): Promise<Locator> {
    const candidates: Locator[] = [
      page.locator('textarea[placeholder*="DeepSeek" i]').first(),
      page.locator('textarea[placeholder*="给 DeepSeek" i]').first(),
      page.locator('textarea').first(),
      page.locator('[contenteditable="true"]').first(),
      page.locator('[role="textbox"]').first(),
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
      page.locator('div[role="button"][aria-disabled="false"]').last(),
      page.locator('button[aria-label*="send" i]').first(),
      page.locator('button[aria-label*="发送" i]').first(),
      page.locator('button:has(svg)').last(),
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

    const filled = await input.fill(message).then(
      () => true,
      () => false,
    );
    if (!filled) {
      await page.keyboard.insertText(message);
    }

    // DeepSeek accepts Enter for submission; the dedicated send button
    // sometimes only enables after a small debounce, so Enter is more
    // reliable as the primary path.
    await page.keyboard.press("Enter");
  }

  async extractLastAssistantMessage(page: Page): Promise<string> {
    const candidates: Locator[] = [
      // DeepSeek doesn't expose data-message-author-role consistently,
      // so we walk the message list and pick the last non-user message.
      page.locator('div[class*="message"][class*="assistant" i]').last(),
      page.locator('.markdown, .ds-markdown, .prose').last(),
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

    await sleep(500);

    const stable = await waitUntilStable(
      () => this.extractLastAssistantMessage(page).catch(() => ""),
      {
        timeoutMs,
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
    ];

    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) {
        await locator.click().catch(() => undefined);
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

    let assistantMessageCount = 0;
    try {
      assistantMessageCount = await page
        .locator('.markdown, .ds-markdown, .prose')
        .count();
    } catch {
      assistantMessageCount = 0;
    }

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
      stopButtonFound: false,
      lastAssistantLength,
      pageUrl: page.url(),
    };
  }
}
