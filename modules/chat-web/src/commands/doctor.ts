import fs from "node:fs/promises";
import path from "node:path";

import { launchProviderBrowser } from "../core/browser.js";
import { defaultLogger, type Logger } from "../core/logger.js";
import { logsDir } from "../core/paths.js";
import { createProfileManager } from "../core/profile-manager.js";
import { getProvider, type ProviderDiagnostics } from "../core/provider.js";
import { formatSnapshot, takeSnapshot } from "../core/snapshot.js";

export interface DoctorOptions {
  /** Dump the lightweight snapshot to ~/.chat-web/logs/. */
  snapshot?: boolean;
  /** Dump a PNG screenshot to ~/.chat-web/logs/. */
  screenshot?: boolean;
  /** Dump the raw HTML to ~/.chat-web/logs/. */
  html?: boolean;
  logger?: Logger;
  headless?: boolean;
}

export interface DoctorReport extends ProviderDiagnostics {
  provider: string;
  profileDir: string;
  snapshotFile?: string;
  screenshotFile?: string;
  htmlFile?: string;
}

/**
 * Run a non-destructive health check for a provider profile.
 *
 * Doctor never sends a real chat message — it only opens the provider,
 * inspects the DOM, and optionally dumps debugging artifacts.
 */
export async function doctor(
  providerName: string,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const logger = options.logger ?? defaultLogger;
  const provider = getProvider(providerName);
  const profileManager = createProfileManager();
  const profileDir = profileManager.getProfileDir(providerName);

  const { context, page } = await launchProviderBrowser(providerName, {
    headless: options.headless ?? false,
    profileManager,
  });

  try {
    await provider.open(page);

    // Best-effort settle: most chat sites finish JS init shortly after
    // domcontentloaded. We don't fail on timeout — we just want to give
    // ProseMirror / app shell a chance to render before snapshotting, so
    // doctor sees the same DOM the runtime sees.
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);

    const diagnostics = provider.diagnose
      ? await provider.diagnose(page)
      : await fallbackDiagnose(provider, page);

    let snapshotFile: string | undefined;
    let screenshotFile: string | undefined;
    let htmlFile: string | undefined;

    if (options.snapshot || options.screenshot || options.html) {
      await fs.mkdir(logsDir(), { recursive: true });
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-");

    if (options.snapshot) {
      const snap = await takeSnapshot(page);
      snapshotFile = path.join(logsDir(), `${ts}-${providerName}-snapshot.json`);
      await fs.writeFile(snapshotFile, JSON.stringify(snap, null, 2), "utf8");
      logger.info(`Wrote snapshot to ${snapshotFile}`);
      // Also print a human-readable form to stderr for quick inspection.
      logger.debug(formatSnapshot(snap));
    }

    if (options.screenshot) {
      screenshotFile = path.join(logsDir(), `${ts}-${providerName}-screenshot.png`);
      await page.screenshot({ path: screenshotFile, fullPage: true });
      logger.info(`Wrote screenshot to ${screenshotFile}`);
    }

    if (options.html) {
      htmlFile = path.join(logsDir(), `${ts}-${providerName}-page.html`);
      const html = await page.content();
      await fs.writeFile(htmlFile, html, "utf8");
      logger.info(`Wrote HTML to ${htmlFile}`);
    }

    return {
      ...diagnostics,
      provider: providerName,
      profileDir,
      snapshotFile,
      screenshotFile,
      htmlFile,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function fallbackDiagnose(
  provider: import("../core/provider.js").ChatProvider,
  page: import("playwright").Page,
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

export function formatDoctorReport(r: DoctorReport): string {
  const lines = [
    `Provider:                ${r.provider}`,
    `Profile:                 ${r.profileDir}`,
    `Page URL:                ${r.pageUrl}`,
    `Login:                   ${r.loggedIn}`,
    `Input found:             ${r.inputFound}`,
    `Send button found:       ${r.sendButtonFound}`,
    `Assistant messages:      ${r.assistantMessageCount}`,
    `Stop button found:       ${r.stopButtonFound}`,
    `Last assistant length:   ${r.lastAssistantLength}`,
  ];
  if (r.snapshotFile) lines.push(`Snapshot:                ${r.snapshotFile}`);
  if (r.screenshotFile) lines.push(`Screenshot:              ${r.screenshotFile}`);
  if (r.htmlFile) lines.push(`HTML:                    ${r.htmlFile}`);
  return lines.join("\n");
}
