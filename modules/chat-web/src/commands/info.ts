import fs from "node:fs/promises";

import { defaultLogger, type Logger } from "../core/logger.js";
import { createProfileManager } from "../core/profile-manager.js";
import { listProviders, getProvider } from "../core/provider.js";
import { ChatSession } from "../session.js";

export interface InfoOptions {
  /** Restrict the report to a single provider. */
  provider?: string;
  /** Actually launch Chromium to verify isLoggedIn live. Default false (fast filesystem-only mode). */
  live?: boolean;
  /** When live, launch headless. Default true (info is usually run from scripts). */
  headless?: boolean;
  logger?: Logger;
}

export interface ProviderInfo {
  name: string;
  homeUrl: string;
  profileDir: string;
  profileExists: boolean;
  /** Last-modified time of the profile dir (ISO-8601), if it exists. */
  profileLastUsed?: string;
  /** Only populated when `live: true`. */
  loggedIn?: boolean;
  /** Filled if a live check failed. */
  liveError?: string;
}

/**
 * Inspect provider login state.
 *
 * Default mode is filesystem-only: cheap, doesn't launch a browser, just
 * tells you which providers have a persisted profile and when it was last
 * touched. Pass `live: true` to actually open Chromium and call
 * `isLoggedIn` on each provider — that's accurate but slow.
 */
export async function info(options: InfoOptions = {}): Promise<ProviderInfo[]> {
  const logger = options.logger ?? defaultLogger;
  const profileManager = createProfileManager();
  const names = options.provider ? [options.provider] : listProviders();

  const results: ProviderInfo[] = [];

  for (const name of names) {
    const provider = getProvider(name);
    const dir = profileManager.getProfileDir(name);

    const stat = await fs.stat(dir).catch(() => null);
    const profileExists = stat !== null && stat.isDirectory();
    const profileLastUsed = stat ? stat.mtime.toISOString() : undefined;

    const entry: ProviderInfo = {
      name,
      homeUrl: provider.homeUrl,
      profileDir: dir,
      profileExists,
      profileLastUsed,
    };

    if (options.live) {
      try {
        const session = await ChatSession.open(name, {
          headless: options.headless ?? true,
          logger,
        });
        try {
          entry.loggedIn = await session.isLoggedIn();
        } finally {
          await session.close();
        }
      } catch (err) {
        entry.liveError = (err as Error).message;
      }
    }

    results.push(entry);
  }

  return results;
}

export function formatInfo(rows: ProviderInfo[]): string {
  if (rows.length === 0) return "No providers registered.";

  const lines: string[] = [];
  for (const r of rows) {
    lines.push(`Provider:        ${r.name}`);
    lines.push(`  Home:          ${r.homeUrl}`);
    lines.push(`  Profile dir:   ${r.profileDir}`);
    lines.push(`  Profile saved: ${r.profileExists ? "yes" : "no"}`);
    if (r.profileLastUsed) {
      lines.push(`  Last used:     ${r.profileLastUsed}`);
    }
    if (r.loggedIn !== undefined) {
      lines.push(`  Logged in:     ${r.loggedIn ? "yes" : "no"}`);
    } else if (r.liveError) {
      lines.push(`  Logged in:     unknown (${r.liveError})`);
    } else if (!r.profileExists) {
      lines.push(`  Logged in:     no (run: chat-web login ${r.name})`);
    } else {
      lines.push(`  Logged in:     unknown (pass --live to check)`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
