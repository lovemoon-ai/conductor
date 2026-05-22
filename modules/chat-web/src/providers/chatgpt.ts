import type { Locator, Page } from "playwright";

import {
  InputNotFoundError,
  ResponseExtractionError,
  ResponseTimeoutError,
} from "../core/errors.js";
import { typeMultiline } from "../core/keyboard.js";
import type { ChatProvider, ProviderDiagnostics, WaitOptions } from "../core/provider.js";
import { sleep, waitUntilStable } from "../core/response-watcher.js";

import { ChatGPTSSECollector } from "./chatgpt-sse-collector.js";

/**
 * ChatGPT (chatgpt.com) provider adapter.
 *
 * Selectors are intentionally written as fallbacks (RFC §8) — when one
 * breaks we fall back to the next. The strongest contracts we rely on:
 *   - the prompt input is a textarea or contenteditable in the viewport
 *   - assistant messages carry data-message-author-role="assistant"
 *   - while streaming, a "Stop generating" button is present
 *
 * Reply extraction has two paths (see `extractLastAssistantMessage`):
 *   1. SSE collector — listens to `/backend-api/.../conversation` and
 *      reconstructs the model's original markdown (bullets, fences,
 *      tables, link URLs). Preferred.
 *   2. DOM `innerText` fallback — used when SSE parsing returned nothing
 *      (endpoint changed, request errored, ...).
 */
export class ChatGPTAdapter implements ChatProvider {
  readonly name = "chatgpt";
  readonly homeUrl = "https://chatgpt.com/";

  /** One collector per Page. Lazily attached on `open()`. */
  private collectors = new WeakMap<Page, ChatGPTSSECollector>();
  /**
   * Promise that resolves to the assistant markdown for the currently
   * in-flight turn (between `sendMessage` and `waitForResponse`).
   * Per-page so concurrent pages don't collide.
   */
  private pendingTurns = new WeakMap<Page, Promise<string>>();

  async open(page: Page): Promise<void> {
    // Install the SSE collector BEFORE navigating, so we capture any
    // initial streaming responses (e.g. if the previous conversation was
    // mid-stream when we attached). Idempotent across re-opens.
    this.ensureCollector(page);

    await page.goto(this.homeUrl, { waitUntil: "domcontentloaded" }).catch(() => {
      // domcontentloaded can race with redirects; try once more with a longer wait.
      return page.goto(this.homeUrl, { waitUntil: "load", timeout: 30_000 });
    });
    // ChatGPT initialises the ProseMirror editor after DOMContentLoaded.
    // Wait for it (or for the signed-out form) so callers don't race the JS.
    await this.waitForComposerReady(page).catch(() => undefined);
  }

  async isLoggedIn(page: Page): Promise<boolean> {
    // The signed-in state always exposes the ProseMirror composer.
    // We probe the strongest identifier first (id=prompt-textarea), then
    // softer fallbacks for layout changes.
    const candidates = [
      '#prompt-textarea[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      '[contenteditable="true"]',
    ];
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      const visible = await loc.isVisible().catch(() => false);
      if (visible) return true;
    }
    return false;
  }

  async findInput(page: Page): Promise<Locator> {
    // IMPORTANT: do NOT include `textarea` as a candidate. ChatGPT renders
    // a `<textarea class="wcDTda_fallbackTextarea">` sibling to the
    // ProseMirror editor for accessibility, but clicking it is intercepted
    // by the ProseMirror placeholder `<p>`, leading to a 30s timeout.
    const candidates: Locator[] = [
      page.locator('#prompt-textarea[contenteditable="true"]').first(),
      page.locator('div[role="textbox"][contenteditable="true"]').first(),
      page.locator('[contenteditable="true"]').first(),
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
      // Most stable: the explicit id ChatGPT uses on the composer submit.
      page.locator("button#composer-submit-button").first(),
      page.locator('button[aria-label="Send prompt"]').first(),
      page.locator('button[data-testid="send-button"]').first(),
      page.locator('button[aria-label*="Send" i]').first(),
      page.locator('button[aria-label*="发送" i]').first(),
      page.locator('form button[type="submit"]').first(),
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

    // Arm the SSE collector BEFORE we submit so we don't miss the first
    // delta frames. The promise is stashed per-page and consumed by
    // `extractLastAssistantMessage`/`waitForResponse`.
    const collector = this.ensureCollector(page);
    this.pendingTurns.set(page, collector.beginTurn());

    // ProseMirror: click to focus (force:true bypasses the placeholder
    // intercept check — the placeholder lives inside the editor, so a
    // click through it still lands in the right place), then type via the
    // keyboard so the editor's input handlers fire. `locator.fill` is a
    // no-op on contenteditable and `insertText` skips IME handling.
    await input.click({ force: true });
    await input.focus().catch(() => undefined);
    // CRITICAL: use `typeMultiline`, not `page.keyboard.type(message)`.
    // ChatGPT's ProseMirror binds Enter to "submit prompt"; `keyboard.type`
    // emits a literal Enter key event for every "\n" in the message, which
    // causes multi-line prompts to be submitted line-by-line. The helper
    // converts newlines into Shift+Enter (soft line break) presses.
    await typeMultiline(page, message);

    // Prefer clicking the send button — it gives us a cleaner state
    // transition (the button toggles to "Stop generating" while streaming).
    const send = await this.findSendButton(page);
    if (send && (await send.isEnabled().catch(() => false))) {
      await send.click({ force: true }).catch(async () => {
        await page.keyboard.press("Enter");
      });
    } else {
      await page.keyboard.press("Enter");
    }
  }

  /** Wait up to `timeoutMs` for the ProseMirror composer to be ready. */
  private async waitForComposerReady(page: Page, timeoutMs = 15_000): Promise<void> {
    const sel =
      '#prompt-textarea[contenteditable="true"], div[role="textbox"][contenteditable="true"]';
    await page.locator(sel).first().waitFor({ state: "visible", timeout: timeoutMs });
  }

  async extractLastAssistantMessage(page: Page): Promise<string> {
    // Path 1: SSE collector. When wiring is healthy this gives us the
    // model's original markdown (code fences, list prefixes, link URLs).
    //
    // IMPORTANT: use `getCurrentTurnText`, not `getLastAssistantText`.
    // The latter used to return the most-recent *finalized* turn's text,
    // which silently leaked the previous turn's answer when the current
    // turn's SSE was empty / racy (task 09b34cf4-… symptom: "1+1=2" reply
    // showing up under a long arXiv prompt).
    const collector = this.collectors.get(page);
    if (collector) {
      const sseText = collector.getCurrentTurnText();
      if (sseText && sseText.trim()) return sseText.trim();
    }

    // Path 2: DOM innerText fallback. Loses markdown structure but is the
    // safety net when the streaming endpoint changes / is unreachable /
    // hasn't finished yet.
    const candidates: Locator[] = [
      page.locator('[data-message-author-role="assistant"]').last(),
      page.locator("main article").last(),
      page.locator(".markdown, .prose").last(),
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

    // Path A: if `sendMessage` armed the SSE collector, the most reliable
    // "done" signal is the SSE response finishing. It also returns the
    // model's original markdown, which is what we ultimately want.
    const pending = this.pendingTurns.get(page);
    if (pending) {
      this.pendingTurns.delete(page);
      const winner = await Promise.race([
        pending.then((text) => ({ kind: "sse" as const, text })),
        new Promise<{ kind: "timeout" }>((resolve) =>
          setTimeout(() => resolve({ kind: "timeout" }), timeoutMs),
        ),
      ]);
      if (winner.kind === "sse" && winner.text && winner.text.trim()) {
        return winner.text.trim();
      }
      // Either timeout or empty SSE → fall through to the DOM fallback.
    }

    // Path B (fallback): RFC §10 — use the stop-button toggle + text
    // stability. We get here when either the SSE wasn't armed (e.g. an
    // older Page that bypassed `sendMessage`) or the SSE returned empty.

    // Phase 1: wait for streaming to actually begin (stop button appears).
    await this.waitForStopButton(page, { timeoutMs: 15_000 }).catch(() => undefined);

    // Phase 2: wait until the stop button is gone (= generation ended).
    const remaining = Math.max(deadline - Date.now(), 5_000);
    await this.waitForStopButtonGone(page, remaining).catch(() => undefined);

    // Phase 3: text-stability sanity check, with the rest of the budget.
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
      throw new ResponseTimeoutError(this.name, timeoutMs);
    }
    return stable;
  }

  async newChat(page: Page): Promise<void> {
    const candidates: Locator[] = [
      page.locator('a[href="/"]').first(),
      page.getByRole("button", { name: /new chat/i }).first(),
      page.getByRole("link", { name: /new chat/i }).first(),
    ];

    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) {
        await locator.click().catch(() => undefined);
        return;
      }
    }

    // Fallback: just navigate to the home URL.
    await this.open(page);
  }

  async diagnose(page: Page): Promise<ProviderDiagnostics> {
    const [loggedIn, sendBtn, assistantCount, stopFound] = await Promise.all([
      this.isLoggedIn(page),
      this.findSendButton(page).then((l) => l !== null),
      page.locator('[data-message-author-role="assistant"]').count().catch(() => 0),
      page
        .locator('button[aria-label*="Stop" i], button[aria-label*="停止" i]')
        .first()
        .isVisible()
        .catch(() => false),
    ]);

    let inputFound = false;
    try {
      await this.findInput(page);
      inputFound = true;
    } catch {
      inputFound = false;
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
      assistantMessageCount: assistantCount,
      stopButtonFound: stopFound,
      lastAssistantLength,
      pageUrl: page.url(),
    };
  }

  /** Look up (and lazily create + attach) the SSE collector for a Page. */
  private ensureCollector(page: Page): ChatGPTSSECollector {
    let c = this.collectors.get(page);
    if (!c) {
      c = new ChatGPTSSECollector();
      c.attach(page);
      this.collectors.set(page, c);
      // Drop our reference when the page closes so the collector can GC.
      page.once("close", () => {
        c?.dispose();
        this.collectors.delete(page);
        this.pendingTurns.delete(page);
      });
    }
    return c;
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
        // Require a few consecutive "gone" samples to avoid catching a
        // brief click-debounce gap during the chain-of-thought / answer
        // handoff that happens on reasoning models.
        consecutiveGone += 1;
        if (consecutiveGone >= 3) return;
      } else {
        consecutiveGone = 0;
      }
      await sleep(200);
    }
  }

  private async isStopButtonVisible(page: Page): Promise<boolean> {
    // ChatGPT exposes the stop-generating control as the composer-submit
    // button in "stop" mode. The aria-label changes ("Stop generating",
    // "Stop streaming", "停止生成", ...). We probe the data-* fingerprint
    // first, then fall back to aria-label heuristics.
    const selectors = [
      "button#composer-submit-button[data-state=stop]",
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop" i]',
      'button[aria-label*="停止" i]',
    ];
    for (const sel of selectors) {
      const visible = await page.locator(sel).first().isVisible().catch(() => false);
      if (visible) return true;
    }
    return false;
  }
}

function isThinkingPlaceholder(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.length > 80) return false;
  // Lower-cased prefix match covers ChatGPT's reasoning placeholders.
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
