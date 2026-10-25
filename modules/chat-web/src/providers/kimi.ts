import type { Locator, Page } from "playwright";

import {
  ChatWebError,
  InputNotFoundError,
  NotLoggedInError,
  ProviderCaptchaError,
  ProviderRateLimitedError,
  ResponseExtractionError,
  ResponseTimeoutError,
  SendButtonNotFoundError,
} from "../core/errors.js";
import { gotoOrThrowNetworkError } from "../core/navigate.js";
import type { ChatProvider, ProviderDiagnostics, WaitOptions } from "../core/provider.js";
import { sleep } from "../core/response-watcher.js";

const INPUT = '.chat-input-editor[contenteditable="true"][role="textbox"]';
const SEND = ".send-button-container";

interface AssistantMessage {
  text: string;
  error: string;
  pending: boolean;
  afterLastUser: boolean;
}

interface KimiPageState {
  loggedIn: boolean;
  loginRequired: boolean;
  captcha: boolean;
  busy: boolean;
  userCount: number;
  assistants: AssistantMessage[];
}

/** Executed inside the page. Keep this function self-contained. */
export function readKimiPage(): KimiPageState {
  // Object methods remain self-contained under tsx's keepNames transform;
  // named arrow helpers otherwise introduce an unavailable __name in Chromium.
  const dom = {
    visible(element: Element): boolean {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    },
    hasVisible(selector: string): boolean {
      return Array.from(document.querySelectorAll(selector)).some(dom.visible);
    },
    fence(text: string, language = ""): string {
      const runs = text.match(/`{3,}/g) ?? [];
      const ticks = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
      return `\n\n${ticks}${language}\n${text.replace(/\n$/, "")}\n${ticks}\n\n`;
    },
    markdown(node: Node): string {
      if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
      if (!(node instanceof HTMLElement)) return "";
      if (node.matches('script, style, button, header, [aria-hidden="true"], .segment-code-header')) return "";
      if (node.matches(".segment-code")) {
        const code = node.querySelector<HTMLElement>(".segment-code-content");
        const language = node.querySelector(".segment-code-lang")?.textContent?.trim().toLowerCase() ?? "";
        return code ? dom.fence(code.innerText, language) : "";
      }
      if (node.tagName === "PRE") {
        const code = node.querySelector("code");
        const language = code?.className.match(/language-([\w+-]+)/)?.[1] ?? "";
        return dom.fence(node.innerText, language);
      }
      if (node.tagName === "BR") return "\n";
      const text = Array.from(node.childNodes).map(dom.markdown).join("");
      switch (node.tagName) {
        case "CODE": {
          const ticks = "`".repeat(Math.max(1, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1)));
          return `${ticks}${text}${ticks}`;
        }
        case "STRONG": case "B": return `**${text}**`;
        case "EM": case "I": return `*${text}*`;
        case "A": {
          const href = node.getAttribute("href");
          return href ? `[${text}](${href})` : text;
        }
        case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
          return `\n\n${"#".repeat(Number(node.tagName[1]))} ${text.trim()}\n\n`;
        case "LI": return `\n${node.parentElement?.tagName === "OL" ? "1." : "-"} ${text.trim()}\n`;
        case "BLOCKQUOTE": return `\n\n${text.trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
        case "P": case "DIV": case "UL": case "OL": return `\n\n${text}\n\n`;
        default: return text;
      }
    },
  };
  const account = !!document.querySelector('[data-testid="sidebar-user-menu-trigger"]');
  const loginRequired = dom.hasVisible(".login-modal-next-mask") ||
    (!account && dom.hasVisible(".login-button, .not-login-icon"));

  const segments = Array.from(document.querySelectorAll(".segment-user, .segment-assistant")).filter(dom.visible);
  const lastUser = segments.reduce((last, segment, index) => segment.matches(".segment-user") ? index : last, -1);
  const assistants = segments.flatMap((segment, index): AssistantMessage[] => {
    if (!segment.matches(".segment-assistant")) return [];
    const blocks = Array.from(segment.querySelectorAll<HTMLElement>(".segment-content-box .markdown"))
      .filter((block) => !block.closest(".thinking-container, .toolcall-container, .toolcall-flow, .segment-error"))
      .filter((block) => !block.parentElement?.closest(".markdown"));
    return [{
      text: blocks.map((block) => dom.markdown(block).trim()).filter(Boolean).join("\n\n"),
      error: segment.querySelector<HTMLElement>(".segment-error")?.innerText.trim() ?? "",
      pending: !!segment.querySelector(".segment-pending-loading"),
      afterLastUser: index > lastUser && lastUser >= 0,
    }];
  });
  return {
    loggedIn: account && !loginRequired,
    loginRequired,
    captcha: dom.hasVisible('iframe[src*="captcha"], .captcha-container'),
    busy: dom.hasVisible(".send-button-container.stop, .send-button-container.loading"),
    userCount: segments.filter((segment) => segment.matches(".segment-user")).length,
    assistants,
  };
}

/** Kimi's website is a separate provider from the Kimi CLI backend. */
export class KimiAdapter implements ChatProvider {
  readonly name = "kimi";
  readonly homeUrl = "https://www.kimi.com/";
  private turns = new WeakMap<Page, { assistantCount: number; userCount: number }>();

  async open(page: Page): Promise<void> {
    this.turns.delete(page);
    await gotoOrThrowNetworkError(page, this.homeUrl, this.name);
    await this.waitForReady(page);
  }

  async resumeConversation(page: Page, conversationId: string): Promise<void> {
    this.turns.delete(page);
    await gotoOrThrowNetworkError(page, `${this.homeUrl}chat/${encodeURIComponent(conversationId)}`, this.name);
    await this.waitForReady(page);
    await page.locator(".segment-user").first().waitFor({ state: "visible", timeout: 20_000 });
    // A restored history can appear before Kimi settles a server-side stop.
    // Stop any resumed stream and require a short stable idle state before
    // the caller submits its next (new) message. Never replay the old prompt.
    const deadline = Date.now() + 20_000;
    let idleSince: number | undefined;
    while (Date.now() < deadline) {
      const state = await page.evaluate(readKimiPage);
      if (state.busy) {
        idleSince = undefined;
        await this.stopGeneration(page);
      } else {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= 500) return;
      }
      await sleep(100);
    }
    throw new ResponseTimeoutError(this.name, 20_000);
  }

  private async waitForReady(page: Page): Promise<void> {
    await page.locator(INPUT).first().waitFor({ state: "visible", timeout: 20_000 });
    // The composer appears before the account query finishes. Wait for the
    // account's settled UI before ChatSession asks isLoggedIn().
    await page.waitForFunction(() => !document.querySelector(".user-area.is-pending") && document.querySelector(
      '[data-testid="sidebar-user-menu-trigger"], .not-login-icon, .login-button',
    ) !== null, undefined, { timeout: 20_000 });
  }

  async isLoggedIn(page: Page): Promise<boolean> {
    return (await page.evaluate(readKimiPage)).loggedIn;
  }

  async findInput(page: Page): Promise<Locator> {
    const input = page.locator(INPUT).first();
    if (await input.isVisible()) return input;
    throw new InputNotFoundError(this.name);
  }

  async findSendButton(page: Page): Promise<Locator | null> {
    const send = page.locator(SEND).first();
    return await send.isVisible() ? send : null;
  }

  async sendMessage(page: Page, message: string): Promise<void> {
    const before = await page.evaluate(readKimiPage);
    if (!before.loggedIn) throw new NotLoggedInError(this.name);
    if (before.busy || this.turns.has(page)) {
      throw new ChatWebError("SELECTOR_VERIFICATION", "Kimi is still generating a reply; wait before sending again.", { provider: this.name });
    }
    const input = await this.findInput(page);
    this.turns.set(page, { assistantCount: before.assistants.length, userCount: before.userCount });
    try {
      // Lexical supports fill() including literal newlines. Never type Enter
      // as a fallback after an uncertain click: it can submit a second turn.
      await input.fill(message);
      const send = await this.findSendButton(page);
      if (!send) throw new SendButtonNotFoundError(this.name);
      await page.locator(`${SEND}:not(.disabled):not(.stop):not(.loading)`).first()
        .waitFor({ state: "visible", timeout: 10_000 });
      await send.click({ timeout: 10_000 });
    } catch (error) {
      this.turns.delete(page);
      throw error;
    }
  }

  async waitForResponse(page: Page, options: WaitOptions = {}): Promise<string> {
    const baseline = this.turns.get(page);
    if (!baseline) throw new ResponseExtractionError(this.name, "No Kimi turn is pending.");
    const timeoutMs = options.timeoutMs ?? 180_000;
    const stableMs = options.stableMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;
    let last = "";
    let stableSince = Date.now();
    try {
      while (Date.now() < deadline) {
        if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await page.evaluate(readKimiPage);
        if (Date.now() >= deadline) break;
        if (state.loginRequired) throw new NotLoggedInError(this.name);
        if (state.captcha) throw new ProviderCaptchaError(this.name);
        // A fresh user turn AND a fresh assistant segment are required.
        // Comparing text alone breaks when consecutive answers are identical.
        const current = state.userCount > baseline.userCount && state.assistants.length > baseline.assistantCount
          ? state.assistants.at(-1) : undefined;
        if (current?.afterLastUser && current.error) {
          if (/rate.?limit|too many|频繁|限流|额度|上限/i.test(current.error)) throw new ProviderRateLimitedError(this.name);
          throw new ResponseExtractionError(this.name, current.error);
        }
        const text = current?.afterLastUser ? current.text : "";
        if (text !== last) {
          last = text;
          stableSince = Date.now();
          if (text) options.onProgress?.(text);
        }
        // Stability alone is insufficient during a long thinking/tool pause.
        if (state.busy || current?.pending || !text) stableSince = Date.now();
        if (text && !state.busy && !current?.pending && Date.now() - stableSince >= stableMs) return text;
        await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
      }
      // Do not report an incomplete answer as a successful turn.
      throw new ResponseTimeoutError(this.name, timeoutMs);
    } finally {
      this.turns.delete(page);
    }
  }

  async extractLastAssistantMessage(page: Page): Promise<string> {
    const last = (await page.evaluate(readKimiPage)).assistants.at(-1);
    if (!last?.text || last.error) throw new ResponseExtractionError(this.name, last?.error || undefined);
    return last.text;
  }

  async newChat(page: Page): Promise<void> {
    this.turns.delete(page);
    await this.open(page);
  }

  async stopGeneration(page: Page): Promise<void> {
    const stop = page.locator(`${SEND}.stop`).first();
    if (await stop.isVisible()) {
      await stop.click({ timeout: 2_000 });
      await page.locator(`${SEND}.stop, ${SEND}.loading`).waitFor({ state: "hidden", timeout: 5_000 });
    }
  }

  getConversationId(page: Page): string | null {
    try {
      const url = new URL(page.url());
      if (url.hostname !== "www.kimi.com" && url.hostname !== "kimi.com") return null;
      return url.pathname.match(/^\/chat\/([a-zA-Z0-9_-]+)\/?$/)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  async diagnose(page: Page): Promise<ProviderDiagnostics> {
    const state = await page.evaluate(readKimiPage);
    return {
      loggedIn: state.loggedIn,
      inputFound: await page.locator(INPUT).first().isVisible(),
      sendButtonFound: (await this.findSendButton(page)) !== null,
      assistantMessageCount: state.assistants.length,
      stopButtonFound: state.busy,
      lastAssistantLength: state.assistants.at(-1)?.text.length ?? 0,
      pageUrl: page.url(),
    };
  }
}
