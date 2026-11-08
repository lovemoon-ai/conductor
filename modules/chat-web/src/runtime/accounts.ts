import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserContext } from "playwright";
import { rootDir } from "../core/paths.js";
import { RuntimeError } from "./types.js";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
interface AccountAuth { version: 1; updatedAt: number; state: StorageState; }
export function runtimeAccountsDirectory(): string { return path.join(rootDir(), "runtime", "accounts"); }

function accountFile(provider: string, accountId: string, directory: string): string {
  if (![provider, accountId].every(value => /^[a-zA-Z0-9_-]{1,80}$/.test(value))) {
    throw new RuntimeError("INVALID_PARAMS", "Invalid provider or account id");
  }
  return path.join(directory, provider, accountId + ".json");
}

function credentialsOnly(provider: string, state: StorageState): StorageState {
  const keys = provider === "kimi"
    ? /^(access_token|refresh_token|msh_user_id|msh_user_subscription_data|__snaker__id|ntes_utid|volcano-token-info|[A-F0-9]{16,64})$/
    : provider === "deepseek"
    ? /^(userToken|__appKit_userInfo|deepseek-device-id:chat|settingsJwt|smidV2|__ds_remote_feature_did)$/
    : undefined;
  if (!keys) return state;
  // Draft databases and last-selected conversation keys must never seed a new chat.
  return { cookies: state.cookies, origins: state.origins.map(origin => ({
    origin: origin.origin, localStorage: origin.localStorage.filter(item => keys.test(item.name)),
  })).filter(origin => origin.localStorage.length > 0) };
}

/** Account snapshots contain credentials, never conversation profiles or browser locks. */
export async function saveRuntimeAccount(provider: string, state: StorageState, accountId = "default", directory = runtimeAccountsDirectory()): Promise<void> {
  const file = accountFile(provider, accountId, directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 1, updatedAt: Date.now(), state: credentialsOnly(provider, state) }), { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function readRuntimeAccount(provider: string, accountId = "default", directory = runtimeAccountsDirectory()): Promise<AccountAuth | undefined> {
  let text: string;
  try { text = await fs.readFile(accountFile(provider, accountId, directory), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const auth = JSON.parse(text) as AccountAuth;
  if (auth.version !== 1 || !Number.isFinite(auth.updatedAt) || !Array.isArray(auth.state?.cookies) || !Array.isArray(auth.state?.origins)) {
    throw new RuntimeError("INVALID_AUTH_STATE", "Account login state is invalid; sign in again");
  }
  return { ...auth, state: credentialsOnly(provider, auth.state) };
}

export async function applyRuntimeAccount(context: BrowserContext, state: StorageState): Promise<void> {
  if (typeof context.setStorageState === "function") { await context.setStorageState(state); return; }
  if (state.origins.some(origin => (origin as { indexedDB?: unknown[] }).indexedDB?.length)) {
    throw new RuntimeError("BROWSER_UPGRADE_REQUIRED", "This login uses IndexedDB; upgrade Playwright to restore it");
  }
  // Older Playwright can seed localStorage on an intercepted temporary page.
  // A permanent init script would reset refreshed tokens on every navigation.
  await context.clearCookies();
  await context.addCookies(state.cookies);
  const page = await context.newPage();
  try {
    await page.route("**/*", route => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html>" }));
    for (const origin of state.origins) {
      await page.goto(origin.origin, { waitUntil: "domcontentloaded" });
      await page.evaluate(items => {
        localStorage.clear();
        for (const item of items) localStorage.setItem(item.name, item.value);
      }, origin.localStorage);
    }
  } finally { await page.close(); }
}
