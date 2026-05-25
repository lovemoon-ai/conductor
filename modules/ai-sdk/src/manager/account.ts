import { readFile, writeFile, copyFile, chmod, rename, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  parseAuthFile,
  parseAuthFileContents,
  type CodexAuthFile,
} from "./auth-parser.js";
import { DEFAULT_CODEX_AUTH } from "./paths.js";
import type { AiManagerConfig, CodexAccount, SwitchResult } from "./types.js";

/** Derive the short account name from the file path. */
export function accountNameFromPath(path: string): string {
  const base = basename(path);
  return base.replace(/^auth_/, "").replace(/\.json$/, "");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

function fingerprintOfPath(p: string): string | undefined {
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as CodexAuthFile;
    return parseAuthFileContents(data).identityFingerprint;
  } catch {
    return undefined;
  }
}

async function readCurrentFingerprint(codexAuthPath: string): Promise<string | undefined> {
  if (!(await fileExists(codexAuthPath))) return undefined;
  const info = await parseAuthFile(codexAuthPath);
  return info.identityFingerprint;
}

export async function listCodexAccounts(
  config: AiManagerConfig,
  codexAuthPath: string = DEFAULT_CODEX_AUTH,
): Promise<CodexAccount[]> {
  const currentFp = await readCurrentFingerprint(codexAuthPath);
  const out: CodexAccount[] = [];

  for (const path of config.codex.authJson) {
    const entry: CodexAccount = {
      name: accountNameFromPath(path),
      path,
      isCurrent: false,
    };
    try {
      const info = await parseAuthFile(path);
      entry.email = info.email;
      entry.accountId = info.accountId;
      entry.planType = info.planType;
      entry.lastRefresh = info.lastRefresh;
      entry.isCurrent = Boolean(
        currentFp && info.identityFingerprint && currentFp === info.identityFingerprint,
      );
    } catch {
      // leave entry minimal; caller can see that name/path exist but details missing
    }
    out.push(entry);
  }

  return out;
}

export async function getCurrentCodexAccount(
  config: AiManagerConfig,
  codexAuthPath: string = DEFAULT_CODEX_AUTH,
): Promise<CodexAccount | null> {
  const accounts = await listCodexAccounts(config, codexAuthPath);
  return accounts.find((a) => a.isCurrent) ?? null;
}

function assertValidAuthJson(data: unknown): asserts data is CodexAuthFile {
  if (!data || typeof data !== "object") {
    throw new Error("auth.json is not a JSON object");
  }
  const tokens = (data as any).tokens;
  if (!tokens || typeof tokens.access_token !== "string" || tokens.access_token.length < 20) {
    throw new Error("auth.json is missing a valid tokens.access_token");
  }
}

function nameForFingerprint(
  config: AiManagerConfig,
  fingerprint: string | undefined,
): string | undefined {
  if (!fingerprint) return undefined;
  for (const p of config.codex.authJson) {
    if (fingerprintOfPath(p) === fingerprint) return accountNameFromPath(p);
  }
  return undefined;
}

export async function switchCodexAccount(
  config: AiManagerConfig,
  name: string,
  codexAuthPath: string = DEFAULT_CODEX_AUTH,
): Promise<SwitchResult> {
  const match = config.codex.authJson.find((p) => accountNameFromPath(p) === name);
  if (!match) {
    const available = config.codex.authJson.map(accountNameFromPath).join(", ") || "<none>";
    throw new Error(`codex account "${name}" not found in config (available: ${available})`);
  }

  const raw = await readFile(match, "utf8");
  let data: CodexAuthFile;
  try {
    data = JSON.parse(raw) as CodexAuthFile;
  } catch (err) {
    throw new Error(`target auth.json is not valid JSON: ${(err as Error).message}`);
  }
  assertValidAuthJson(data);

  const targetInfo = parseAuthFileContents(data);
  const backupPath = `${codexAuthPath}.bak`;
  let previousName: string | undefined;

  if (await fileExists(codexAuthPath)) {
    try {
      const prevInfo = await parseAuthFile(codexAuthPath);
      previousName = nameForFingerprint(config, prevInfo.identityFingerprint);
      if (
        prevInfo.identityFingerprint &&
        targetInfo.identityFingerprint &&
        prevInfo.identityFingerprint === targetInfo.identityFingerprint
      ) {
        return { previousName, newName: name, backupPath };
      }
    } catch {
      // Best-effort; still back up raw contents below
    }
    await copyFile(codexAuthPath, backupPath);
  }

  const tmp = `${codexAuthPath}.tmp`;
  await writeFile(tmp, raw, { mode: 0o600 });
  await rename(tmp, codexAuthPath);
  await chmod(codexAuthPath, 0o600).catch(() => {});

  return { previousName, newName: name, backupPath };
}
