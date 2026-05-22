import { chromium, type BrowserContext, type Page } from "playwright";

import { BrowserLaunchError } from "./errors.js";
import { createProfileManager, type BrowserProfileManager } from "./profile-manager.js";

export interface LaunchOptions {
  /** Override headless. Defaults to headed (RFC §19.3) but `false` is overridden by env vars. */
  headless?: boolean;
  /** Width × height of the viewport. */
  viewport?: { width: number; height: number };
  /** Extra Chromium args. Merged after our defaults. */
  args?: string[];
  /** Inject a custom profile manager (mostly for testing). */
  profileManager?: BrowserProfileManager;
}

export interface LaunchedBrowser {
  context: BrowserContext;
  page: Page;
  /** The userDataDir that was used. Useful for doctor / debug output. */
  userDataDir: string;
}

/**
 * Launch (or reattach to) a persistent Chromium context for a provider.
 *
 * Important: we use `launchPersistentContext`, NOT `browser.newContext`,
 * because ChatGPT / DeepSeek depend on more than just cookies (see RFC §19.1).
 */
export async function launchProviderBrowser(
  provider: string,
  options: LaunchOptions = {},
): Promise<LaunchedBrowser> {
  const profileManager = options.profileManager ?? createProfileManager();
  const userDataDir = await profileManager.ensureProfile(provider);

  const headless = resolveHeadless(options.headless);
  const viewport = options.viewport ?? { width: 1280, height: 900 };

  try {
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      viewport,
      args: [
        // Hide the obvious "I'm an automated browser" signal that several
        // chat sites probe via navigator.webdriver. RFC §19.3.
        "--disable-blink-features=AutomationControlled",
        ...(options.args ?? []),
      ],
    });

    const existing = context.pages();
    const page = existing.length > 0 ? existing[0]! : await context.newPage();

    return { context, page, userDataDir };
  } catch (err) {
    throw new BrowserLaunchError(
      provider,
      `Failed to launch Chromium for "${provider}" at ${userDataDir}: ${(err as Error).message}`,
      err,
    );
  }
}

function resolveHeadless(explicit: boolean | undefined): boolean {
  if (typeof explicit === "boolean") return explicit;
  const env = process.env.CHAT_WEB_HEADLESS;
  if (env === "1" || env === "true") return true;
  // Default to headed, per RFC §19.3 (better against anti-bot heuristics).
  return false;
}
