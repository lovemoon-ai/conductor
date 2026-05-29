import type { BrowserContext, Page } from "playwright";

import { launchProviderBrowser, type LaunchOptions } from "./core/browser.js";
import { NotLoggedInError } from "./core/errors.js";
import { clearProfileOwner } from "./core/profile-lock.js";
import { defaultLogger, type Logger } from "./core/logger.js";
import {
  getProvider,
  type ChatProvider,
  type ProviderDiagnostics,
} from "./core/provider.js";
import { takeSnapshot, type PageSnapshot } from "./core/snapshot.js";

export interface SessionOpenOptions {
  /** Run Chromium headless. Defaults to headed (RFC §19.3). */
  headless?: boolean;
  /** Override the logger. */
  logger?: Logger;
  /** Extra Chromium args / viewport overrides forwarded to the browser launcher. */
  launch?: Omit<LaunchOptions, "headless" | "profileManager">;
  /** Auto-open the provider home URL after launch. Default true. */
  autoOpen?: boolean;
}

export interface SendOptions {
  /** Start a fresh chat before sending (clears the conversation context). */
  newChat?: boolean;
  /** Hard upper bound on the response wait. Forwarded to the provider. */
  timeoutMs?: number;
  /** How long the assistant text must stop changing before we declare done. */
  stableMs?: number;
  /** AbortSignal — aborts the wait but does NOT undo the network message. */
  signal?: AbortSignal;
  /** Streaming progress callback. */
  onProgress?: (text: string) => void;
}

export interface SendResult {
  /** 0-based index of this turn within the session's lifetime. */
  turnIndex: number;
  message: string;
  response: string;
  /** Wall-clock duration of this send (ms). */
  durationMs: number;
  /**
   * Provider-side conversation id, when the provider exposes one. For
   * ChatGPT this is the UUID at `chatgpt.com/c/{uuid}`. Stable across
   * turns within the same conversation, undefined on the first response
   * if the provider hasn't navigated to its conversation URL yet.
   */
  conversationId?: string;
}

/**
 * A long-lived chat session bound to one provider account.
 *
 * Think of it as "the thing you'd get if you opened ChatGPT in a browser
 * tab and kept it open" — same persistent profile, same Chromium context,
 * same conversation memory. Multi-turn dialogue happens by calling
 * `session.send()` repeatedly. `session.newChat()` starts a fresh
 * conversation but keeps the browser alive.
 *
 * RFC §19.2: a single account must not be hit concurrently. We enforce
 * this by serialising `send` / `newChat` through an internal FIFO queue,
 * so callers can safely fire-and-await from multiple async paths.
 */
export class ChatSession {
  /** Open and return a ready-to-use session. */
  static async open(
    providerName: string,
    options: SessionOpenOptions = {},
  ): Promise<ChatSession> {
    const logger = options.logger ?? defaultLogger;
    const provider = getProvider(providerName);

    const { context, page, userDataDir } = await launchProviderBrowser(providerName, {
      headless: options.headless,
      ...options.launch,
    });

    const session = new ChatSession(provider, context, page, userDataDir, logger);

    try {
      if (options.autoOpen !== false) {
        await provider.open(page);
      }
    } catch (err) {
      // Don't leak the browser if open() throws.
      await context.close().catch(() => undefined);
      clearProfileOwner(userDataDir);
      throw err;
    }

    return session;
  }

  /**
   * Build a session around an already-launched browser context. Mostly
   * used by tests / advanced callers that manage the browser themselves;
   * regular code should go through `ChatSession.open()`.
   */
  static fromBrowser(args: {
    provider: ChatProvider;
    context: BrowserContext;
    page: Page;
    userDataDir: string;
    logger?: Logger;
  }): ChatSession {
    return new ChatSession(
      args.provider,
      args.context,
      args.page,
      args.userDataDir,
      args.logger ?? defaultLogger,
    );
  }

  private turnCounter = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** Provider-side conversation id (e.g. ChatGPT `/c/{uuid}`), set after the first turn lands. */
  private providerConversationId: string | undefined;

  private constructor(
    private readonly providerImpl: ChatProvider,
    private readonly context: BrowserContext,
    private readonly pageImpl: Page,
    public readonly userDataDir: string,
    private readonly logger: Logger,
  ) {}

  get provider(): string {
    return this.providerImpl.name;
  }

  get page(): Page {
    return this.pageImpl;
  }

  get turns(): number {
    return this.turnCounter;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Quick check: is the provider profile signed in? */
  async isLoggedIn(): Promise<boolean> {
    this.assertOpen();
    return this.providerImpl.isLoggedIn(this.pageImpl);
  }

  /**
   * Send one message and await the assistant's full reply.
   *
   * Calls are serialised per session — overlapping `send`s from different
   * callers won't trample each other; they queue up and run in order.
   */
  async send(message: string, options: SendOptions = {}): Promise<SendResult> {
    this.assertOpen();
    return this.enqueue(async () => {
      const started = Date.now();

      const loggedIn = await this.providerImpl.isLoggedIn(this.pageImpl);
      if (!loggedIn) {
        throw new NotLoggedInError(this.providerImpl.name);
      }

      if (options.newChat && this.providerImpl.newChat) {
        this.logger.debug(`[${this.providerImpl.name}] starting fresh chat before send`);
        await this.providerImpl.newChat(this.pageImpl);
        await this.providerImpl.open(this.pageImpl);
      }

      this.logger.debug(
        `[${this.providerImpl.name}] turn ${this.turnCounter}: ${truncate(message)}`,
      );
      await this.providerImpl.sendMessage(this.pageImpl, message);

      const response = await this.providerImpl.waitForResponse(this.pageImpl, {
        timeoutMs: options.timeoutMs,
        stableMs: options.stableMs,
        signal: options.signal,
        onProgress: options.onProgress,
      });

      const turnIndex = this.turnCounter;
      this.turnCounter += 1;

      // Capture the provider-side conversation id (e.g. ChatGPT's
      // /c/{uuid}). The URL is navigated by the provider *during* the
      // reply, so we read it after waitForResponse settles. We also
      // remember it on the session for cross-turn access and emit a
      // session-info update so listeners (ai-sdk) see the change.
      const conversationId = this.captureConversationId();

      return {
        turnIndex,
        message,
        response,
        durationMs: Date.now() - started,
        conversationId,
      };
    });
  }

  /**
   * Provider-side conversation id (e.g. ChatGPT's /c/{uuid}). `undefined`
   * before the first turn has landed, then stable for the rest of this
   * `ChatSession` unless `newChat()` is called.
   */
  get conversationId(): string | undefined {
    return this.providerConversationId;
  }

  /**
   * Read the conversation id from the current page (provider permitting)
   * and store it on the session. Idempotent — repeated calls within the
   * same conversation will see the same id; the first call captures it.
   */
  private captureConversationId(): string | undefined {
    if (typeof this.providerImpl.getConversationId !== "function") return undefined;
    try {
      const next = this.providerImpl.getConversationId(this.pageImpl) ?? undefined;
      if (next && next !== this.providerConversationId) {
        this.providerConversationId = next;
      }
      return this.providerConversationId;
    } catch {
      return this.providerConversationId;
    }
  }

  /** Start a fresh conversation while keeping the session/browser open. */
  async newChat(): Promise<void> {
    this.assertOpen();
    return this.enqueue(async () => {
      if (!this.providerImpl.newChat) {
        throw new Error(
          `Provider "${this.providerImpl.name}" does not implement newChat().`,
        );
      }
      await this.providerImpl.newChat(this.pageImpl);
      await this.providerImpl.open(this.pageImpl);
      // Reset the turn counter — a new chat is a new conversation.
      this.turnCounter = 0;
      // A new chat means a new provider-side conversation id; clear so
      // we don't leak the old UUID into the next turn's session info.
      this.providerConversationId = undefined;
    });
  }

  /** Provider-specific health probe (input found, send button found, ...). */
  async diagnose(): Promise<ProviderDiagnostics> {
    this.assertOpen();
    return this.providerImpl.diagnose
      ? this.providerImpl.diagnose(this.pageImpl)
      : fallbackDiagnose(this.providerImpl, this.pageImpl);
  }

  /** Snapshot of interactive DOM elements (ref-based). */
  async snapshot(): Promise<PageSnapshot> {
    this.assertOpen();
    return takeSnapshot(this.pageImpl);
  }

  /** Close the browser context. Safe to call multiple times. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => undefined);
    // Drop the owner sidecar so a later launch doesn't mistake a cleanly
    // closed profile for a live chat (see core/profile-lock.ts).
    clearProfileOwner(this.userDataDir);
  }

  /** Enables `await using session = …` (TC39 explicit resource management). */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`ChatSession for "${this.providerImpl.name}" is already closed.`);
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    // Chain on prior task; do NOT block on its failure (we don't want
    // one bad message to wedge the queue forever).
    const ran = this.queue.then(task, task);
    this.queue = ran.then(
      () => undefined,
      () => undefined,
    );
    return ran;
  }
}

/** Convenience wrapper: open → callback → close, regardless of throws. */
export async function withSession<T>(
  providerName: string,
  body: (session: ChatSession) => Promise<T>,
  options: SessionOpenOptions = {},
): Promise<T> {
  const session = await ChatSession.open(providerName, options);
  try {
    return await body(session);
  } finally {
    await session.close();
  }
}

async function fallbackDiagnose(
  provider: ChatProvider,
  page: Page,
): Promise<ProviderDiagnostics> {
  const [loggedIn, sendBtn] = await Promise.all([
    provider.isLoggedIn(page),
    provider.findSendButton(page).then((l) => l !== null).catch(() => false),
  ]);

  let inputFound = false;
  try {
    await provider.findInput(page);
    inputFound = true;
  } catch {
    inputFound = false;
  }

  return {
    loggedIn,
    inputFound,
    sendButtonFound: sendBtn,
    assistantMessageCount: 0,
    stopButtonFound: false,
    lastAssistantLength: 0,
    pageUrl: page.url(),
  };
}

function truncate(s: string, max = 80): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
