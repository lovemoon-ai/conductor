import fs from "node:fs/promises";

import { ProfileError } from "./errors.js";
import { profileDir, profilesDir, logsDir, rootDir } from "./paths.js";

/**
 * Profile manager owns the on-disk layout for persistent browser profiles.
 *
 * RFC §19.1: we persist the full Chromium userDataDir per provider
 * (cookies + localStorage + IndexedDB + service workers), not just cookies.
 */
export interface BrowserProfileManager {
  getProfileDir(provider: string): string;
  ensureProfile(provider: string): Promise<string>;
  clearProfile(provider: string): Promise<void>;
  listProfiles(): Promise<string[]>;
}

export function createProfileManager(): BrowserProfileManager {
  return {
    getProfileDir(provider) {
      return profileDir(provider);
    },

    async ensureProfile(provider) {
      const dir = profileDir(provider);
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.mkdir(logsDir(), { recursive: true });
        await fs.mkdir(rootDir(), { recursive: true });
      } catch (err) {
        throw new ProfileError(provider, `Failed to create profile dir at ${dir}`, err);
      }
      return dir;
    },

    async clearProfile(provider) {
      const dir = profileDir(provider);
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (err) {
        throw new ProfileError(provider, `Failed to clear profile dir at ${dir}`, err);
      }
    },

    async listProfiles() {
      try {
        const entries = await fs.readdir(profilesDir(), { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return [];
        throw err;
      }
    },
  };
}
