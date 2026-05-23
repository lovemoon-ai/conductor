import type { Locator, Page } from "playwright";

import {
  InputNotFoundError,
  ProviderApiKeyRequiredError,
  ProviderAutomationBlockedError,
  ProviderPermissionDeniedError,
  ProviderRateLimitedError,
  ResponseExtractionError,
  ResponseTimeoutError,
} from "../core/errors.js";
import { typeMultiline } from "../core/keyboard.js";
import { gotoOrThrowNetworkError } from "../core/navigate.js";
import type { ChatProvider, ProviderDiagnostics, WaitOptions } from "../core/provider.js";
import { sleep, waitUntilStable } from "../core/response-watcher.js";

/**
 * Google AI Studio (aistudio.google.com/prompts/new_chat) provider
 * adapter.
 *
 * This is what users colloquially mean by "Gemini" — the free web-chat
 * interface that lets you talk to Gemini models without an API key
 * (the "No API key selected" button on the page is a separate, optional
 * feature for users who want to use their own key; the page is fully
 * usable without it). chat-web does NOT target gemini.google.com — in
 * practice many networks block that domain while AI Studio reaches
 * fine, and AI Studio is the surface users actually expect.
 *
 * Observed structure (2026-05):
 *   - Composer: `<ms-prompt-box>` (Angular Material) wrapping a textarea
 *     with `aria="Enter a prompt"`, `placeholder="Start typing..."`.
 *   - Run button: NO aria-label; visible text is "Run" + two Material
 *     icon font ligatures (`keyboard_command_key`, `keyboard_return`).
 *     `type="submit"`. Use `getByRole("button", { name: /^Run$/ })`.
 *   - Stop: the same submit button flips to a stop state; its
 *     aria-label changes to include "Stop". Detect via aria-label
 *     substring.
 *   - Assistant turn: `<ms-chat-turn>` containing a
 *     `.chat-turn-container.model` with `.turn-content`. innerText
 *     leaks "Model HH:MM AM/PM" headers and Material icon font
 *     ligatures (`edit`, `more_vert`, `error`, ...) as plain text —
 *     stripped by {@link stripChromeFromTurn}.
 *   - Conversation id: `/prompts/{slug}` once the prompt is saved; the
 *     placeholder `/prompts/new_chat` does NOT count.
 */
export class GeminiAdapter implements ChatProvider {
  readonly name = "gemini";
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
    // The Run button has NO aria-label — getByRole("button", { name: /^Run$/ })
    // resolves the accessible name from visible "Run" text, then we fall
    // back to type=submit / :has-text("Run").
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
    // CRITICAL: AI Studio defaults to "Grounding with Google Search"
    // enabled on every new chat. With Grounding on, the page calls a
    // Google Search backend BEFORE invoking the model — and on many
    // user networks (especially behind DPI boxes that drop Google
    // Search Suggest / search infrastructure traffic) that call hangs
    // silently, leaving the UI stuck on "Thinking" forever even though
    // the model invocation request (GenerateContent / streamGenerateContent)
    // is never made. Disabling Grounding makes a simple "1+1=" return
    // "2" instantly, since there's no pre-flight search step.
    //
    // We close the Grounding chip if it's present. Idempotent: if the
    // chip has already been removed (sticky across the profile's
    // session storage), this is a no-op.
    await this.disableGroundingWithGoogleSearch(page).catch(() => undefined);

    const input = await this.findInput(page);
    await input.click();
    // typeMultiline preserves newlines correctly. Angular Material's
    // form state requires real input events (locator.fill() leaves Run
    // disabled forever).
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

  /**
   * AI Studio shows a "Grounding with Google Search" chip on every new
   * chat by default. The chip has a close (×) button with
   * `aria-label="Remove Grounding with Google Search"`. Clicking it
   * disables the grounding step for this conversation — and removes a
   * silent hang point on networks that can't reach Google Search.
   */
  private async disableGroundingWithGoogleSearch(page: Page): Promise<void> {
    const closer = page
      .locator('button[aria-label="Remove Grounding with Google Search"]')
      .first();
    if (await closer.isVisible().catch(() => false)) {
      await closer.click({ force: true }).catch(() => undefined);
      await sleep(150);
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
    // AI Studio defaults to a high "Thinking level" + Grounding with
    // Google Search (the chip is on at first visit) — a single prompt
    // routinely takes 2-4 minutes. Bump the default budget to 5 min so
    // we don't time out before the model finishes streaming. Callers
    // who want a tighter cap pass an explicit timeoutMs.
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    const stableMs = options.stableMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;

    // Phase 1: wait for streaming to begin (stop button appears).
    await this.waitForStopButton(page, { timeoutMs: 15_000 }).catch(() => undefined);

    // Phase 2: wait for streaming to end.
    const remaining = Math.max(deadline - Date.now(), 5_000);
    await this.waitForStopButtonGone(page, remaining).catch(() => undefined);

    // Phase 3: text stability — but treat the "Thinking" placeholder
    // (rendered while AI Studio is generating) as "not yet" so we don't
    // accidentally return that as the final answer.
    const stable = await waitUntilStable(
      async () => {
        const text = await this.extractLastAssistantMessage(page).catch(() => "");
        if (isThinkingPlaceholder(text)) return "";
        return text;
      },
      {
        timeoutMs: Math.max(deadline - Date.now(), 1_500),
        stableMs,
        signal: options.signal,
        onProgress: options.onProgress,
      },
    );
    if (!stable) {
      // Distinguish "took too long" from "AI Studio's WAA anti-abuse
      // silently blocked the request". If the page never navigated off
      // /prompts/new_chat AND the model turn body is still "Thinking",
      // the JS pipeline never actually invoked the model (it's stuck
      // in the WAA challenge retry loop — see the lesson doc). Throw a
      // typed error with an actionable hint instead of a vague timeout.
      if (await this.looksAutomationBlocked(page)) {
        throw new ProviderAutomationBlockedError(
          this.name,
          "The model invocation request was never made — Google's anti-abuse challenge (WAA) likely blocked it.",
        );
      }
      throw new ResponseTimeoutError(this.name, timeoutMs);
    }

    // AI Studio renders upstream errors AS the model turn body (so
    // "stable" successfully extracts an "answer" that's actually an
    // error message). Catch the well-known patterns and throw typed
    // errors instead of surfacing the error string as the model's reply.
    await this.throwIfKnownUpstreamError(page, stable);

    return stable;
  }

  /**
   * Inspect the freshly-extracted "assistant" text and raise a typed
   * error if it's really an upstream failure that AI Studio just
   * rendered in the model turn slot.
   *
   * Known patterns:
   *   - "An internal error has occurred."  → typically quota /
   *     server-side error (the user has reproduced this when their
   *     free-tier daily quota was exhausted).
   *   - "Failed to generate content: permission denied."  → API key
   *     missing or model not enabled on the account.
   *
   * The actual root cause for "internal error" varies (preview model
   * outage, daily quota cap, region restriction, transient backend
   * error). We don't try to disambiguate further — the hint just lists
   * the common ones so the user knows where to look.
   */
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
      if (cause === "permission-denied") {
        throw new ProviderPermissionDeniedError(this.name, text);
      }
      // No specific UI indicator — surface as a rate-limited / quota
      // problem since that's the most common cause of an opaque
      // "internal error" on the free tier.
      throw new ProviderRateLimitedError(this.name);
    }

    if (lower.includes("failed to generate content")) {
      if (lower.includes("permission denied")) {
        throw new ProviderPermissionDeniedError(this.name, text);
      }
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

  /**
   * Heuristic: are we stuck in the WAA-blocked state where AI Studio
   * never moves past "Thinking" and the URL still says new_chat? Used
   * to surface a clearer error than a generic timeout.
   */
  private async looksAutomationBlocked(page: Page): Promise<boolean> {
    const url = page.url();
    if (!url.includes("/prompts/new_chat")) return false;
    const text = await this.extractLastAssistantMessage(page).catch(() => "");
    return isThinkingPlaceholder(text);
  }

  /**
   * AI Studio's per-prompt URL is `/prompts/{slug}` after the prompt is
   * saved. Until then the URL stays at `/prompts/new_chat` (no
   * conversation id).
   */
  getConversationId(page: Page): string | null {
    const url = page.url();
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

  private async pressRunShortcut(page: Page): Promise<void> {
    // AI Studio binds Cmd/Ctrl+Enter to Run.
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
    // AI Studio's Stop button has NO aria-label — its visible text is
    // "progress_activity Stop" (a Material icon ligature + the word
    // "Stop"). The accessible name resolves to "Stop" via the visible
    // text, so getByRole(name=/Stop/) catches it. We keep the
    // aria-label fallbacks in case Google adds them later.
    const stopByRole = await page
      .getByRole("button", { name: /^Stop$/i })
      .first()
      .isVisible()
      .catch(() => false);
    if (stopByRole) return true;

    const stopByText = await page
      .locator('button:has-text("Stop")')
      .first()
      .isVisible()
      .catch(() => false);
    if (stopByText) return true;

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
 * Strip the UI chrome that leaks into `innerText` on AI Studio model
 * turns. Removes:
 *   - The "Model HH:MM AM/PM" turn header
 *   - Single-line Material icon font ligatures (rendered as plain text
 *     words because the icon-font substitution doesn't affect text
 *     extraction): edit, more_vert, error, content_copy, thumb_up,
 *     thumb_down, refresh, delete, close, expand_more, expand_less,
 *     code, play_arrow, stop, menu.
 *
 * Does NOT remove lines where the same word appears INSIDE a sentence
 * (e.g. "an error occurred during parsing" stays as-is).
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

/**
 * AI Studio renders "Thinking" / "Thought for Ns" / "正在思考" while the
 * model is reasoning before its first content token. Those strings
 * appear in the model turn's innerText for a while; treating them as
 * "the final answer" is the same class of bug as ChatGPT's pre-stream
 * `Thinking` placeholder.
 */
function isThinkingPlaceholder(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length > 80) return false;
  const lower = t.toLowerCase();
  return (
    lower === "thinking" ||
    lower === "thinking…" ||
    lower === "thinking..." ||
    lower.startsWith("thinking\n") ||
    lower.startsWith("thought for ") ||
    lower.startsWith("reasoning") ||
    lower.startsWith("思考") ||
    lower.startsWith("正在思考")
  );
}
