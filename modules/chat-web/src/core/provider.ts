import type { Locator, Page } from "playwright";

import { UnknownProviderError } from "./errors.js";

export interface WaitOptions {
  /** Hard upper bound for the whole response wait. Default 120_000ms. */
  timeoutMs?: number;
  /** How long the text must stop changing before we call it done. Default 2000ms. */
  stableMs?: number;
  /** Optional cancellation. */
  signal?: AbortSignal;
  /** Streaming progress callback. */
  onProgress?: (text: string) => void;
}

/**
 * The minimum surface every provider has to implement so `ask`, `doctor`,
 * `new-chat` and the daemon can be provider-agnostic.
 *
 * Adapters MUST NOT share logic via mixins — RFC §13.2 explicitly calls
 * out that ChatGPT and DeepSeek should not be merged into one branch.
 */
export interface ChatProvider {
  readonly name: string;
  readonly homeUrl: string;

  open(page: Page): Promise<void>;
  isLoggedIn(page: Page): Promise<boolean>;

  findInput(page: Page): Promise<Locator>;
  findSendButton(page: Page): Promise<Locator | null>;
  sendMessage(page: Page, message: string): Promise<void>;

  waitForResponse(page: Page, options?: WaitOptions): Promise<string>;
  extractLastAssistantMessage(page: Page): Promise<string>;

  newChat?(page: Page): Promise<void>;

  /** For doctor: cheap summary numbers (counts + booleans). */
  diagnose?(page: Page): Promise<ProviderDiagnostics>;

  /**
   * Provider-side conversation identifier as exposed by the web UI.
   *
   * For ChatGPT this is the UUID at `https://chatgpt.com/c/{uuid}`. For
   * Gemini AI Studio it would be the prompts/* id segment. Implement when
   * the provider exposes a stable per-conversation id in its URL/state;
   * the SDK surfaces it as the canonical session id and pushes it through
   * `ChatSession.conversationId` / `SendResult.conversationId` so callers
   * (ai-sdk, frontend) can render real-provider-side links.
   */
  getConversationId?(page: Page): string | null;
}

export interface ProviderDiagnostics {
  loggedIn: boolean;
  inputFound: boolean;
  sendButtonFound: boolean;
  assistantMessageCount: number;
  stopButtonFound: boolean;
  lastAssistantLength: number;
  pageUrl: string;
}

class ProviderRegistry {
  private providers = new Map<string, ChatProvider>();

  register(provider: ChatProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): ChatProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new UnknownProviderError(name, [...this.providers.keys()]);
    }
    return provider;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }
}

export const providerRegistry = new ProviderRegistry();

export function getProvider(name: string): ChatProvider {
  return providerRegistry.get(name);
}

export function registerProvider(provider: ChatProvider): void {
  providerRegistry.register(provider);
}

export function listProviders(): string[] {
  return providerRegistry.list();
}
