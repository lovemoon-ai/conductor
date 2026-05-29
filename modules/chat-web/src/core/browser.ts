import { chromium, type BrowserContext, type Page } from "playwright";

import { BrowserLaunchError } from "./errors.js";
import {
  autoInstallDisabled,
  hasAttemptedAutoInstall,
  installChromium,
  isBrowserMissingError,
  markAutoInstallAttempted,
} from "./install-chromium.js";
import { defaultLogger, type Logger } from "./logger.js";
import { reclaimProfileLock, writeProfileOwner } from "./profile-lock.js";
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
  /** Logger used for the (rare) auto-install path. */
  logger?: Logger;
  /**
   * Disable the runtime auto-install of Chromium. Defaults to honouring
   * the `CHAT_WEB_NO_AUTO_INSTALL` / `CHAT_WEB_SKIP_BROWSER_INSTALL`
   * env vars; pass `true` to force-disable regardless.
   */
  noAutoInstall?: boolean;
  /**
   * Use a specific Chromium-family browser channel instead of the
   * Playwright-bundled `chrome-headless-shell`. Accepts the standard
   * Playwright channel ids: `"chrome"` / `"chrome-beta"` / `"msedge"` /
   * `"chromium"`. Honours the `CHAT_WEB_BROWSER_CHANNEL` env var.
   *
   * When set, Playwright uses the system-installed binary (so e.g.
   * `channel: "chrome"` means "the same Google Chrome you double-click
   * on the dock"). Mutually exclusive with `executablePath` — if both
   * are provided, `executablePath` wins.
   *
   * Note: this does NOT bypass Google's WAA anti-abuse on AI Studio
   * (verified: system Chrome + headed + the same userDataDir still
   * gets blocked because WAA detects the CDP connection itself, not
   * the binary identity). It's still useful for the other providers
   * (ChatGPT, DeepSeek) when the user's network treats Playwright's
   * `chrome-headless-shell` differently from real Chrome.
   */
  channel?: string;
  /**
   * Explicit path to a Chrome / Chromium binary. Overrides `channel`.
   * Honours the `CHAT_WEB_BROWSER_EXECUTABLE` env var.
   *
   * Example (macOS):
   *   `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
   */
  executablePath?: string;
}

export interface LaunchedBrowser {
  context: BrowserContext;
  page: Page;
  /** The userDataDir that was used. Useful for doctor / debug output. */
  userDataDir: string;
}

interface PlaywrightLaunchArgs {
  headless: boolean;
  viewport: { width: number; height: number };
  args: string[];
  channel?: string;
  executablePath?: string;
}

/**
 * Launch (or reattach to) a persistent Chromium context for a provider.
 *
 * Important: we use `launchPersistentContext`, NOT `browser.newContext`,
 * because ChatGPT / DeepSeek depend on more than just cookies (see RFC §19.1).
 *
 * First-run UX: if Playwright reports that the Chromium binary is not
 * installed (a very common state under pnpm 10+, which silently blocks
 * the `playwright` postinstall script), we run
 * `npx playwright install chromium` once and retry the launch. Disable
 * via `CHAT_WEB_NO_AUTO_INSTALL=1` (or `noAutoInstall: true` on the call).
 */
export async function launchProviderBrowser(
  provider: string,
  options: LaunchOptions = {},
): Promise<LaunchedBrowser> {
  const profileManager = options.profileManager ?? createProfileManager();
  const userDataDir = await profileManager.ensureProfile(provider);
  const logger = options.logger ?? defaultLogger;

  const launchArgs: PlaywrightLaunchArgs = {
    headless: resolveHeadless(options.headless),
    viewport: options.viewport ?? { width: 1280, height: 900 },
    args: [
      // Hide the obvious "I'm an automated browser" signal that several
      // chat sites probe via navigator.webdriver. RFC §19.3.
      "--disable-blink-features=AutomationControlled",
      ...(options.args ?? []),
    ],
    ...resolveBrowserBinary(options),
  };

  // Enforce "one live chat per profile" and self-heal stale/orphaned locks
  // before launching. Throws ProfileLockedError if a genuine live chat for
  // this provider is still running (see profile-lock.ts).
  await reclaimProfileLock({ userDataDir, provider, logger });

  try {
    const launched = await launch(userDataDir, launchArgs);
    writeProfileOwner(userDataDir, provider);
    return launched;
  } catch (err) {
    // First-failure recovery path: if Chromium isn't installed, try to
    // install it once and retry the launch.
    const shouldAutoInstall =
      isBrowserMissingError(err) &&
      !hasAttemptedAutoInstall() &&
      !(options.noAutoInstall || autoInstallDisabled());

    if (!shouldAutoInstall) {
      throw new BrowserLaunchError(
        provider,
        `Failed to launch Chromium for "${provider}" at ${userDataDir}: ${(err as Error).message}`,
        err,
      );
    }

    markAutoInstallAttempted();
    logger.warn(
      `chat-web: Chromium binary not found; attempting one-time install (\`npx playwright install chromium\`).`,
    );
    try {
      await installChromium({ logger });
    } catch (installErr) {
      throw new BrowserLaunchError(
        provider,
        `Auto-install of Chromium failed for "${provider}". Run manually: \`npx playwright install chromium\` (cause: ${(installErr as Error).message})`,
        installErr,
      );
    }

    try {
      const launched = await launch(userDataDir, launchArgs);
      writeProfileOwner(userDataDir, provider);
      return launched;
    } catch (retryErr) {
      throw new BrowserLaunchError(
        provider,
        `Failed to launch Chromium for "${provider}" at ${userDataDir} even after auto-install: ${(retryErr as Error).message}`,
        retryErr,
      );
    }
  }
}

async function launch(userDataDir: string, launchArgs: PlaywrightLaunchArgs): Promise<LaunchedBrowser> {
  const context = await chromium.launchPersistentContext(userDataDir, launchArgs);
  const existing = context.pages();
  const page = existing.length > 0 ? existing[0]! : await context.newPage();
  return { context, page, userDataDir };
}

function resolveHeadless(explicit: boolean | undefined): boolean {
  if (typeof explicit === "boolean") return explicit;
  const env = process.env.CHAT_WEB_HEADLESS;
  if (env === "1" || env === "true") return true;
  // Default to headed, per RFC §19.3 (better against anti-bot heuristics).
  return false;
}

/**
 * Decide which Chromium-family binary to launch:
 *
 *   - Explicit `options.executablePath` (or env `CHAT_WEB_BROWSER_EXECUTABLE`)
 *     wins outright.
 *   - Otherwise `options.channel` (or env `CHAT_WEB_BROWSER_CHANNEL`)
 *     selects a Playwright "channel" — `"chrome"` for system Google
 *     Chrome, `"msedge"` for system Edge, etc.
 *   - Otherwise undefined → Playwright defaults to its bundled
 *     `chrome-headless-shell` build.
 */
function resolveBrowserBinary(options: LaunchOptions): {
  channel?: string;
  executablePath?: string;
} {
  const explicitExec = options.executablePath?.trim() || process.env.CHAT_WEB_BROWSER_EXECUTABLE?.trim();
  if (explicitExec) return { executablePath: explicitExec };
  const explicitChannel = options.channel?.trim() || process.env.CHAT_WEB_BROWSER_CHANNEL?.trim();
  if (explicitChannel) return { channel: explicitChannel };
  return {};
}
