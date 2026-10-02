import { randomBytes } from "node:crypto";
import path from "node:path";

import { requestRemoteFile } from "@/lib/realtime/remote-file";
import { createTransfer, deleteTransfer, getTransfer, updateTransfer } from "@/lib/transfers/transfer-store";
import { signTransferToken } from "@/lib/transfers/transfer-token";
import { previewMaxBytes } from "@/shared/utils/file-preview";

/**
 * Temporary, link-addressed read access to one directory on a daemon, so a
 * file the AI wrote there can be opened from the chat.
 *
 * The token in the URL is the only credential: a sandboxed page cannot send
 * the app's bearer token, and its sub-resources (CSS, images, `fetch`) have to
 * resolve as plain relative URLs. Everything below exists to keep that link
 * small: it dies after five idle minutes and thirty absolute ones, reaches one
 * directory, and can move a bounded number of bytes.
 *
 * Files are fetched lazily, one `push` each, over the existing remote-file
 * channel (RFC 0037) and cached for the life of the session.
 */
export const PREVIEW_IDLE_TTL_MS = 5 * 60 * 1000;
export const PREVIEW_MAX_TTL_MS = 30 * 60 * 1000;
const PREVIEW_MAX_TOTAL_BYTES = 300 * 1024 * 1024;
const PREVIEW_MAX_FILES = 200;
/** One per directory (see `createPreviewSession`); a chat showing pictures
 *  from many folders opens several at once. */
const PREVIEW_MAX_SESSIONS_PER_USER = 20;
/**
 * How many daemon requests one user's previews may have in flight: two file
 * fetches and one `stat`. A daemon takes four requests per user and refuses
 * the fifth outright, so a reply with ten pictures has to queue here rather
 * than fail there — and three leaves `conductor remote cp` a slot of its own.
 */
const PREVIEW_PUSH_CONCURRENCY = 2;
const PREVIEW_STAT_CONCURRENCY = 1;
/** Under nginx's 60s idle cut-off: the response cannot start until the daemon
 *  has finished uploading the file. */
const PUSH_TIMEOUT_MS = 50_000;
const SWEEP_INTERVAL_MS = 30_000;

export type PreviewFile =
  | { ok: true; transferId: string; sizeBytes: number }
  | { ok: false; status: number; message: string };

interface PreviewSession {
  token: string;
  userId: string;
  agentHost: string;
  /** Symlink-resolved directory on the daemon; nothing above it is served. */
  rootPath: string;
  expiresAt: number;
  hardExpiresAt: number;
  files: Map<string, Promise<PreviewFile>>;
  totalBytes: number;
}

interface Lane {
  running: number;
  waiting: Array<() => void>;
}

// On `globalThis` for the same reason as `realtimeHub`: the route that mints a
// session and the route that serves it must see one Map.
const globalForPreviews = globalThis as unknown as {
  conductorPreviewSessions?: Map<string, PreviewSession>;
  conductorPreviewLanes?: Map<string, Lane>;
  conductorPreviewJanitor?: NodeJS.Timeout;
};
const sessions = (globalForPreviews.conductorPreviewSessions ??= new Map<string, PreviewSession>());
const lanes = (globalForPreviews.conductorPreviewLanes ??= new Map<string, Lane>());

async function destroySession(session: PreviewSession): Promise<void> {
  sessions.delete(session.token);
  const files = [...session.files.values()];
  session.files.clear();
  for (const file of await Promise.all(files)) {
    if (file.ok) await deleteTransfer(file.transferId);
  }
}

export async function pruneExpiredPreviews(now = Date.now()): Promise<number> {
  let pruned = 0;
  for (const session of [...sessions.values()]) {
    if (session.expiresAt > now && session.hardExpiresAt > now) continue;
    await destroySession(session);
    pruned += 1;
  }
  return pruned;
}

function ensureJanitor(): void {
  if (globalForPreviews.conductorPreviewJanitor) return;
  const timer = setInterval(() => {
    void pruneExpiredPreviews().catch(() => undefined);
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  globalForPreviews.conductorPreviewJanitor = timer;
}

export function createPreviewSession(input: {
  userId: string;
  agentHost: string;
  rootPath: string;
}): { token: string; expiresAt: number } | null {
  const now = Date.now();
  let owned = 0;
  for (const session of sessions.values()) {
    if (session.userId !== input.userId) continue;
    owned += 1;
    // The same directory again — a second picture in one reply, a re-opened
    // report — reuses the link (and its fetched files) instead of minting one
    // per file. Not when it is about to hit its absolute limit, though.
    if (
      session.agentHost === input.agentHost &&
      session.rootPath === input.rootPath &&
      session.hardExpiresAt - now > PREVIEW_IDLE_TTL_MS &&
      touchSession(session.token)
    ) {
      return { token: session.token, expiresAt: session.expiresAt };
    }
  }
  if (owned >= PREVIEW_MAX_SESSIONS_PER_USER) return null;

  const session: PreviewSession = {
    token: randomBytes(32).toString("base64url"),
    userId: input.userId,
    agentHost: input.agentHost,
    rootPath: input.rootPath,
    expiresAt: now + PREVIEW_IDLE_TTL_MS,
    hardExpiresAt: now + PREVIEW_MAX_TTL_MS,
    files: new Map(),
    totalBytes: 0,
  };
  sessions.set(session.token, session);
  ensureJanitor();
  return { token: session.token, expiresAt: session.expiresAt };
}

/** Look a session up and, if it is still alive, push its idle deadline out. */
function touchSession(token: string): PreviewSession | null {
  const session = sessions.get(token);
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt <= now || session.hardExpiresAt <= now) {
    void destroySession(session);
    return null;
  }
  session.expiresAt = Math.min(now + PREVIEW_IDLE_TTL_MS, session.hardExpiresAt);
  return session;
}

/**
 * Normalise a URL path into one relative to the root, or `null` if it tries to
 * leave it or names a dotfile. The daemon repeats both checks against the real
 * (symlink-resolved) path; this one only saves the round trip.
 */
export function normalizePreviewPath(segments: string[]): string | null {
  const joined = segments.join("/");
  if (!joined || joined.includes("\0") || joined.includes("\\")) return null;
  const normalized = path.posix.normalize(joined);
  if (normalized.startsWith("/") || normalized.endsWith("/")) return null;
  if (normalized.split("/").some((segment) => segment.startsWith("."))) return null;
  return normalized;
}

/** Run `run` once fewer than `width` others hold the lane named `key`. */
async function inLane<T>(key: string, width: number, run: () => Promise<T>): Promise<T> {
  let lane = lanes.get(key);
  if (!lane) lanes.set(key, (lane = { running: 0, waiting: [] }));
  if (lane.running >= width) {
    await new Promise<void>((resolve) => lane.waiting.push(resolve));
  } else {
    lane.running += 1;
  }
  try {
    return await run();
  } finally {
    const next = lane.waiting.shift();
    // Hand the slot straight to the next waiter instead of releasing it.
    if (next) next();
    else if ((lane.running -= 1) === 0) lanes.delete(key);
  }
}

/** The `stat` that opens a preview, queued behind the user's other ones. */
export function queuePreviewStat<T>(userId: string, run: () => Promise<T>): Promise<T> {
  return inLane(`stat:${userId}`, PREVIEW_STAT_CONCURRENCY, run);
}

function daemonRefusal(message: string): { status: number; message: string } {
  if (/no such file|not a regular file|is a directory/.test(message)) return { status: 404, message: "file not found" };
  if (/outside the preview root|hidden files|shared root/.test(message)) return { status: 403, message: "file is outside this preview" };
  if (/byte limit/.test(message)) return { status: 413, message: "file is too large to preview" };
  return { status: 502, message };
}

async function fetchFile(session: PreviewSession, relativePath: string): Promise<PreviewFile> {
  let transfer;
  try {
    transfer = createTransfer({
      userId: session.userId,
      agentHost: session.agentHost,
      direction: "down",
      remotePath: path.posix.join(session.rootPath, relativePath),
      preview: { reserveBytes: previewMaxBytes(relativePath) },
    });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "TRANSFER_LIMIT" && code !== "TRANSFER_BUDGET") throw error;
    return { ok: false, status: code === "TRANSFER_LIMIT" ? 429 : 507, message: (error as Error).message };
  }

  const outcome = await requestRemoteFile({
    userId: session.userId,
    agentHost: session.agentHost,
    action: "push",
    args: {
      transferId: transfer.transferId,
      transferToken: signTransferToken({
        transferId: transfer.transferId,
        agentHost: session.agentHost,
        purpose: "push",
      }),
      remotePath: transfer.remotePath,
      rootPath: session.rootPath,
      maxBytes: previewMaxBytes(relativePath),
    },
    timeoutMs: PUSH_TIMEOUT_MS,
  });

  const staged = getTransfer(transfer.transferId, session.userId);
  const sizeBytes = outcome.ok && staged?.sha256 ? staged.sizeBytes : null;
  if (typeof sizeBytes !== "number" || session.totalBytes + sizeBytes > PREVIEW_MAX_TOTAL_BYTES) {
    await deleteTransfer(transfer.transferId);
    if (outcome.ok) {
      return typeof sizeBytes === "number"
        ? { ok: false, status: 413, message: "this preview has reached its size limit" }
        : { ok: false, status: 502, message: "daemon reported success but staged no content" };
    }
    if (outcome.reason === "remote_error") return { ok: false, ...daemonRefusal(outcome.message) };
    const status = outcome.reason === "too_many_inflight" ? 429 : outcome.reason === "timeout" ? 504 : 503;
    return { ok: false, status, message: outcome.message };
  }

  updateTransfer(transfer.transferId, { status: "ready", error: null });
  session.totalBytes += sizeBytes;
  return { ok: true, transferId: transfer.transferId, sizeBytes };
}

/** Answers that will be the same next time; anything else is worth retrying. */
function isCacheable(file: PreviewFile): boolean {
  return file.ok || file.status === 403 || file.status === 404 || file.status === 413;
}

/**
 * Resolve one file of a preview, fetching it from the daemon the first time.
 * `null` means the link itself is dead (unknown or expired).
 */
export async function getPreviewFile(token: string, relativePath: string): Promise<PreviewFile | null> {
  const session = touchSession(token);
  if (!session) return null;

  const cached = session.files.get(relativePath);
  if (cached) return cached;
  if (session.files.size >= PREVIEW_MAX_FILES) {
    return { ok: false, status: 429, message: "this preview has reached its file limit" };
  }

  const pending = inLane(`push:${session.userId}`, PREVIEW_PUSH_CONCURRENCY, () =>
    fetchFile(session, relativePath),
  ).catch(
    (error): PreviewFile => ({
      ok: false,
      status: 500,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  session.files.set(relativePath, pending);
  const file = await pending;
  if (!isCacheable(file) && session.files.get(relativePath) === pending) {
    session.files.delete(relativePath);
  }
  // The session was torn down while this was in flight: do not leave the blob.
  if (file.ok && !sessions.has(token)) {
    await deleteTransfer(file.transferId);
    return null;
  }
  return file;
}

/** The staged blob outlived by its session entry (transfer TTL): fetch again. */
export function forgetPreviewFile(token: string, relativePath: string, sizeBytes: number): void {
  const session = sessions.get(token);
  if (session?.files.delete(relativePath)) session.totalBytes -= sizeBytes;
}

export async function resetPreviewStoreForTests(): Promise<void> {
  for (const session of [...sessions.values()]) await destroySession(session);
}
