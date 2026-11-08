import readline from "node:readline";

import { defaultLogger, type Logger } from "../core/logger.js";
import { saveRuntimeAccount } from "../runtime/accounts.js";
import { NotLoggedInError } from "../core/errors.js";
import { ChatSession } from "../session.js";

export interface LoginOptions {
  logger?: Logger;
  /** When true, exit as soon as the provider reports a logged-in state instead of waiting for the user to press Enter. */
  autoExit?: boolean;
  /** Poll interval for autoExit. */
  pollIntervalMs?: number;
  /** Hard upper bound for the login flow. */
  timeoutMs?: number;
}

/**
 * Open a headed browser so the user can sign in manually.
 *
 * We never automate the actual sign-in (no email/password handling, no
 * captcha bypass). The whole point of `chat-web login` is to give the
 * user a one-time interactive window whose state is then persisted to
 * the provider profile.
 */
export async function login(providerName: string, options: LoginOptions = {}): Promise<void> {
  const logger = options.logger ?? defaultLogger;

  const session = await ChatSession.open(providerName, {
    headless: false,
    logger,
  });

  try {
    logger.info(
      `Opened ${session.provider} in a Chromium window backed by ${session.userDataDir}.`,
    );
    logger.info("Complete the sign-in flow in the browser window.");

    if (options.autoExit) {
      if (!(await waitForLoggedIn(session, options, logger))) throw new NotLoggedInError(providerName);
      logger.info(`Detected logged-in state for ${providerName}. Closing browser.`);
    } else {
      logger.info("When done, press Enter in this terminal to close the browser.");
      await waitForEnter();
    }

    if (await session.isLoggedIn()) {
      if (["kimi", "deepseek"].includes(providerName)) {
        await saveRuntimeAccount(providerName, await session.page.context().storageState({ indexedDB: true }));
      }
      logger.info(`Saved persistent profile for ${providerName} at ${session.userDataDir}.`);
    } else {
      if (options.autoExit) throw new NotLoggedInError(providerName);
      logger.warn(
        `Could not verify login for ${providerName}. The browser was closed without a confirmed signed-in state.`,
      );
    }
  } finally {
    await session.close();
  }
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}

async function waitForLoggedIn(
  session: ChatSession,
  options: LoginOptions,
  logger: Logger,
): Promise<boolean> {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ok = await session.isLoggedIn().catch(() => false);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  logger.warn("Timed out waiting for login.");
  return false;
}
