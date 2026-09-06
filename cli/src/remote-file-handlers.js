import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import { resolveUserHome } from "./conductor-paths.js";
import { isPathInsideGuestRoot } from "./guest-daemon.js";

const VALID_ACTIONS = new Set(["pull", "push", "stat"]);
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
/**
 * One request carries at most this much.
 *
 * Chunking is what makes a transfer resumable, and it is also what keeps a
 * 1 GiB limit safe: a single request is bounded in duration and in how much any
 * proxy in the path has to hold, so a failure costs one chunk instead of the
 * whole file. Mirrors `cli/src/remote/cp.js` so both ends behave the same.
 */
const DEFAULT_CHUNK_BYTES = 32 * 1024 * 1024;
/**
 * Per *request*, not per transfer: a 1 GiB file legitimately takes longer than
 * any single deadline worth setting, but a chunk that has not moved in five
 * minutes is stuck and the retry loop should be told so.
 */
const REQUEST_TIMEOUT_MS = 300_000;
/** Four tries, 500 ms apart and doubling: ~3.5 s of blip absorbed, then stop. */
const RETRY_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 500;
/**
 * Byte streams are far heavier than an exec run, so this cap is much tighter
 * than `MAX_CONCURRENT_RUNS`. It bounds this daemon's disk and socket use; the
 * server enforces its own per-user cap independently.
 */
const MAX_CONCURRENT_TRANSFERS = 4;
const NUL = String.fromCharCode(0);

export const REMOTE_FILE_CAPABILITY = "remote_file";

/**
 * Move single files between this daemon's disk and the account that owns it,
 * with the Web backend's staging area as the only hop (RFC 0037).
 *
 * Bytes never touch the agent WebSocket: the control envelope arrives over WS
 * and the daemon then opens an ordinary HTTP stream to the backend, so
 * back-pressure is TCP's problem and a big transfer cannot head-of-line block
 * `stop_task` or `terminal_input`.
 *
 * Transfers are chunked and resumable in both directions: uploads send ranged
 * PUTs and follow the server's `receivedBytes`, downloads resume from the size
 * of the local `.part`. Resume is per call — a blip of a few seconds is
 * invisible, but a failed call still starts over (RFC 0037 deliberately leaves
 * cross-call resume out).
 *
 * Like `remote_exec` this is not a new trust boundary — anyone who can ask for
 * a file here can already ask for `bash -lc 'base64 file'`. It is a separate
 * capability purely so it can be negotiated (an old daemon silently drops an
 * event it does not know, which would strand the caller until timeout) and so
 * a host can decline file transfer while keeping exec.
 *
 * @param {object} opts
 * @param {import("@love-moon/conductor-sdk").ConductorConfig} opts.config source of `backendUrl`/`agentToken`
 * @param {string} opts.agentHost this daemon's name, sent as `X-Conductor-Host`
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.chunkBytes]
 * @param {(ms:number)=>Promise<unknown>} [opts.sleep] backoff hook, injectable for tests
 * @param {string|null} [opts.guestRoot] when set, paths outside it are refused
 */
export function createRemoteFileHandlers(opts = {}) {
  const config = opts.config || null;
  const agentHost = opts.agentHost || "";
  const fetchImpl = opts.fetchImpl || fetch;
  const maxBytes = resolveRemoteFileMaxBytes(opts.maxBytes);
  const chunkBytes = resolveRemoteChunkBytes(opts.chunkBytes);
  const sleep = typeof opts.sleep === "function" ? opts.sleep : delay;
  const guestRoot = opts.guestRoot || null;
  // One controller for the whole daemon: `abortAll()` on shutdown tears down
  // every in-flight stream instead of letting them hold the process open.
  const shutdownController = new AbortController();
  let activeTransfers = 0;

  function requestSignal() {
    return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), shutdownController.signal]);
  }

  /**
   * Retry the transient half of the failure space: a dropped connection, a
   * timed-out chunk, a 5xx. Protocol violations, permanent HTTP statuses and a
   * daemon shutdown are handed straight back, because retrying them only burns
   * the caller's deadline.
   */
  async function withRetry(run) {
    let lastError;
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await run(attempt);
      } catch (error) {
        lastError = error;
        if (error?.permanent || shutdownController.signal.aborted) throw error;
        if (attempt === RETRY_ATTEMPTS - 1) break;
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    }
    throw lastError;
  }

  /**
   * Resolve a caller-supplied path the same way exec resolves a workspace: the
   * owner is not fenced off from their own machine. The guest root is the one
   * exception, and it is a lexical check (no `realpath`), so it prevents
   * mistakes rather than a determined escape — same caveat as everywhere else
   * in this repo.
   */
  function resolveRemotePath(value) {
    const resolved = normalizeRemotePath(value);
    if (guestRoot && !isPathInsideGuestRoot(resolved, guestRoot)) {
      throw new Error(`path is outside this daemon's shared root: ${resolved}`);
    }
    return resolved;
  }

  async function acquireSlot() {
    if (activeTransfers >= MAX_CONCURRENT_TRANSFERS) {
      throw new Error(
        `too many concurrent remote file transfers on this daemon (${activeTransfers}/${MAX_CONCURRENT_TRANSFERS}); retry when one finishes`,
      );
    }
    activeTransfers += 1;
  }

  function releaseSlot() {
    activeTransfers = Math.max(0, activeTransfers - 1);
  }

  function backendUrl(transferId) {
    if (!config?.backendUrl) {
      throw new Error("this daemon has no backend URL configured");
    }
    return new URL(
      `/api/agent/files/${encodeURIComponent(transferId)}/content`,
      config.backendUrl,
    );
  }

  function transferHeaders(transferToken, extra = {}) {
    return {
      Authorization: `Bearer ${config?.agentToken || ""}`,
      "X-Conductor-Host": agentHost,
      "X-Conductor-Transfer-Token": transferToken,
      ...extra,
    };
  }

  /** Download the staged blob and land it atomically at `remotePath`. */
  async function pull(args = {}) {
    const transferId = requireId(args.transferId ?? args.transfer_id, "transferId");
    const transferToken = requireId(args.transferToken ?? args.transfer_token, "transferToken");
    const sha256 = normalizeSha256(args.sha256);
    if (!sha256) {
      throw new Error("pull requires a 64-character hex `sha256`");
    }
    const sizeBytes = normalizeSizeBytes(args.sizeBytes ?? args.size_bytes, maxBytes);
    const mode = normalizeMode(args.mode);
    let dest = resolveRemotePath(args.remotePath ?? args.remote_path);

    // scp semantics: copying onto a directory means "into that directory".
    const destStat = await statOrNull(dest);
    if (destStat?.isDirectory()) {
      const name = normalizeName(args.name) || path.basename(dest);
      if (!name || name === "." || name === "..") {
        throw new Error(`cannot infer a file name for directory destination: ${dest}`);
      }
      dest = resolveRemotePath(path.join(dest, name));
    }

    await acquireSlot();
    try {
      // Already have exactly this content? Then the transfer is a no-op; this
      // is what makes a retried `remote cp` cheap.
      const existing = await statOrNull(dest);
      if (existing?.isFile() && existing.size === sizeBytes && (await hashFile(dest)) === sha256) {
        if (mode !== null) await fsp.chmod(dest, mode);
        return { transferId, bytesWritten: sizeBytes, path: dest };
      }

      // Never truncate the destination in place: a half-written transfer would
      // otherwise corrupt a file that was perfectly good before.
      const temporaryPath = remotePartPath(dest);
      try {
        await withRetry(async () => {
          // The `.part`'s size *is* the offset — no side-car state to keep in
          // sync, and it is still right after a crash mid-write.
          const start = await fileSizeOrZero(temporaryPath);
          const signal = requestSignal();
          const response = await fetchImpl(backendUrl(transferId), {
            headers: transferHeaders(transferToken, {
              Accept: "application/octet-stream",
              ...(start > 0 ? { Range: `bytes=${start}-` } : {}),
            }),
            signal,
          });

          // 416 is not a failure: it means the `.part` is already at (or past)
          // the full size, so there is nothing left to fetch. Verification
          // below decides whether what we hold is actually good.
          if (response?.status === 416) return;
          if (!response?.ok || !response.body) {
            throw httpError("download", response?.status);
          }

          // A server that ignored our Range restarts the file, so the partial
          // is stale: appending to it would interleave two copies.
          let writeFrom = start;
          if (response.status === 206) {
            const range = parseContentRange(response.headers?.get?.("content-range"));
            // Unverifiable placement is not "probably fine": appending bytes on
            // faith is exactly how a resumed download corrupts itself silently.
            if (!range) {
              throw protocolError("download returned 206 without a usable Content-Range");
            }
            if (range.start !== start) {
              throw protocolError(
                `download resumed at the wrong offset: server sent from byte ${range.start}, asked for ${start}`,
              );
            }
            if (range.total !== null && range.total !== sizeBytes) {
              throw protocolError(
                `download Content-Range mismatch: server declared ${range.total} bytes total, expected ${sizeBytes}`,
              );
            }
          } else {
            writeFrom = 0;
          }

          const expected = sizeBytes - writeFrom;
          const declaredLength = parseContentLength(response.headers?.get?.("content-length"));
          if (declaredLength !== null && declaredLength !== expected) {
            throw protocolError(
              `download Content-Length mismatch: server declared ${declaredLength}, expected ${expected}`,
            );
          }

          let received = 0;
          const verifier = new Transform({
            transform(chunk, _encoding, callback) {
              received += chunk.length;
              // Stop at the first byte past the declared size instead of
              // writing the whole overrun to disk and complaining afterwards.
              if (writeFrom + received > sizeBytes || writeFrom + received > maxBytes) {
                callback(
                  protocolError(`download exceeded the declared size of ${sizeBytes} bytes`),
                );
                return;
              }
              callback(null, chunk);
            },
          });
          await pipeline(
            Readable.fromWeb(response.body),
            verifier,
            // `r+` with an explicit start appends exactly where the previous
            // attempt stopped; `w` truncates a stale partial.
            writeFrom > 0
              ? fs.createWriteStream(temporaryPath, { flags: "r+", start: writeFrom })
              : fs.createWriteStream(temporaryPath, { flags: "w", mode: 0o600 }),
            { signal },
          );

          const landed = await fileSizeOrZero(temporaryPath);
          if (landed < sizeBytes) {
            // Ran short: a retry resumes from the new offset rather than
            // starting the whole file again.
            throw new Error(`download ended early at ${landed} of ${sizeBytes} bytes`);
          }
        });

        const landed = await fileSizeOrZero(temporaryPath);
        if (landed !== sizeBytes) {
          throw new Error(`download size mismatch: got ${landed} bytes, expected ${sizeBytes}`);
        }
        // Hash the assembled file, not the stream: a resumed download never saw
        // the earlier bytes go past, so a streaming digest would only cover the
        // last range and would happily accept a corrupt prefix.
        const digest = await hashFile(temporaryPath, requestSignal());
        if (digest !== sha256) {
          throw new Error(`download SHA-256 mismatch: got ${digest}, expected ${sha256}`);
        }
        // chmod before the rename so the file is never visible at its final
        // path with the wrong permissions.
        if (mode !== null) await fsp.chmod(temporaryPath, mode);
        await fsp.rename(temporaryPath, dest);
        return { transferId, bytesWritten: landed, path: dest };
      } catch (error) {
        await fsp.rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
      }
    } finally {
      releaseSlot();
    }
  }

  /** Stream a local file up to the backend's staging area, one chunk at a time. */
  async function push(args = {}) {
    const transferId = requireId(args.transferId ?? args.transfer_id, "transferId");
    const transferToken = requireId(args.transferToken ?? args.transfer_token, "transferToken");
    const source = resolveRemotePath(args.remotePath ?? args.remote_path);

    const stat = await statOrNull(source);
    if (!stat) {
      throw new Error(`no such file: ${source}`);
    }
    if (stat.isDirectory()) {
      throw new Error(`${source} is a directory (recursive transfer is not supported)`);
    }
    if (!stat.isFile()) {
      throw new Error(`${source} is not a regular file`);
    }
    if (stat.size > maxBytes) {
      throw new Error(`${source} is ${stat.size} bytes, over the ${maxBytes} byte limit`);
    }

    await acquireSlot();
    try {
      // Hash before sending so the server can reject a corrupted body, and so
      // the caller can compare end to end. This costs one extra read of the
      // file; the alternative (hash while uploading) cannot be sent in the
      // header the server verifies against.
      const sha256 = await hashFile(source, requestSignal());
      const totalBytes = stat.size;
      let offset = 0;
      let resyncs = 0;
      let final = null;

      // A zero-byte file still needs one request for the server to complete it.
      while (offset < totalBytes || (totalBytes === 0 && !final)) {
        const outcome = await withRetry(async () => {
          const start = offset;
          const end = Math.min(start + chunkBytes, totalBytes) - 1;
          const signal = requestSignal();
          const response = await fetchImpl(backendUrl(transferId), {
            method: "PUT",
            headers: transferHeaders(transferToken, {
              Accept: "application/json",
              "Content-Type": "application/octet-stream",
              "Content-Length": String(totalBytes === 0 ? 0 : end - start + 1),
              // An empty file has no range to describe; no header means "the
              // whole body, from byte 0".
              ...(totalBytes === 0
                ? {}
                : { "Content-Range": `bytes ${start}-${end}/${totalBytes}` }),
            }),
            // Stream the range: a `readFile` of a 1 GiB file would put the
            // whole thing in the daemon's heap.
            body: Readable.toWeb(
              totalBytes === 0
                ? Readable.from([])
                : fs.createReadStream(source, { start, end, signal }),
            ),
            duplex: "half",
            signal,
          });

          // The server owns the truth about how much it holds: a 409 carries
          // the real offset, and seeking there covers both a retried chunk and
          // one the server only half accepted.
          if (response?.status === 409) {
            const received = toNonNegativeInt((await readJsonBody(response))?.receivedBytes);
            if (received === null || received === start) {
              throw httpError("upload", 409);
            }
            return { resyncTo: received };
          }
          if (!response?.ok) {
            throw httpError("upload", response?.status);
          }
          return { payload: await readJsonBody(response), end };
        });

        if (outcome?.resyncTo !== undefined) {
          resyncs += 1;
          if (resyncs > RETRY_ATTEMPTS) {
            throw new Error(
              `upload kept being redirected to a different offset (${resyncs} times); giving up`,
            );
          }
          offset = outcome.resyncTo;
          continue;
        }

        final = outcome.payload ?? {};
        const next = toNonNegativeInt(final.receivedBytes) ?? outcome.end + 1;
        if (totalBytes > 0 && next <= offset) {
          // Without this the loop would re-send the same chunk forever.
          throw new Error(`upload made no progress at byte ${offset} of ${totalBytes}`);
        }
        offset = next;
        if (final.complete || totalBytes === 0) break;
      }

      return {
        transferId,
        sizeBytes: totalBytes,
        sha256,
        mode: stat.mode & 0o777,
        name: path.basename(source),
      };
    } finally {
      releaseSlot();
    }
  }

  /** Probe a path. A missing path is an answer, not an error. */
  async function stat(args = {}) {
    const target = resolveRemotePath(args.remotePath ?? args.remote_path);
    const info = await statOrNull(target);
    if (!info) {
      return {
        path: target,
        exists: false,
        isFile: false,
        isDirectory: false,
        sizeBytes: null,
        mode: null,
        mtime: null,
      };
    }
    return {
      path: target,
      exists: true,
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      sizeBytes: info.size,
      mode: info.mode & 0o777,
      mtime: new Date(info.mtimeMs).toISOString(),
    };
  }

  /**
   * Run a single action and return a `result` object, never throwing.
   * @param {{action:string,args?:object}} payload
   */
  async function dispatch(payload) {
    const action = payload?.action;
    if (!VALID_ACTIONS.has(action)) {
      return { error: `unknown action: ${action}` };
    }
    try {
      switch (action) {
        case "pull":
          return { result: await pull(payload?.args ?? {}) };
        case "push":
          return { result: await push(payload?.args ?? {}) };
        case "stat":
          return { result: await stat(payload?.args ?? {}) };
        default:
          return { error: `unhandled action: ${action}` };
      }
    } catch (err) {
      return { error: errMsg(err) };
    }
  }

  function abortAll() {
    shutdownController.abort(new Error("remote file transfers closed"));
  }

  return { dispatch, abortAll, maxBytes, chunkBytes, guestRoot };
}

/**
 * @param {object} client
 * @param {ReturnType<typeof createRemoteFileHandlers>} handlers
 * @param {object} payload
 */
export async function handleRemoteFileRequest(client, handlers, payload) {
  const requestId = payload?.request_id ? String(payload.request_id) : "";
  const action = payload?.action ? String(payload.action) : "";
  if (!requestId) {
    return { error: "missing request_id" };
  }

  const response = await handlers.dispatch({
    action,
    args: payload?.args && typeof payload.args === "object" ? payload.args : {},
  });

  const outgoing = {
    type: "remote_file_response",
    payload: {
      request_id: requestId,
      action,
      ...(response?.error ? { error: response.error } : { result: response?.result }),
    },
  };
  await client.sendJson(outgoing).catch(() => {});
  return response;
}

/**
 * Resolution order: explicit option, then `CONDUCTOR_REMOTE_FILE_MAX_BYTES`,
 * then the RFC 0037 default of 1 GiB.
 */
export function resolveRemoteFileMaxBytes(value) {
  const explicit = toPositiveInt(value);
  if (explicit) return explicit;
  const fromEnv = toPositiveInt(process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES);
  if (fromEnv) return fromEnv;
  return DEFAULT_MAX_BYTES;
}

/**
 * How much one request carries. Overridable so a flaky link can shrink it —
 * and so tests can exercise the multi-chunk path without moving 32 MiB around.
 */
export function resolveRemoteChunkBytes(value) {
  const explicit = toPositiveInt(value);
  if (explicit) return explicit;
  const fromEnv = toPositiveInt(process.env.CONDUCTOR_REMOTE_CHUNK_BYTES);
  if (fromEnv) return fromEnv;
  return DEFAULT_CHUNK_BYTES;
}

/**
 * Where a download is assembled before it is renamed into place.
 *
 * The name is derived, not random, because the file's own size is the resume
 * offset: a retry inside this call has to find the same partial again. Same
 * shape as the CLI side (`cli/src/remote/cp.js`), and the pid keeps two
 * daemons on one host off each other's partials.
 */
export function remotePartPath(destination) {
  return `${destination}.${process.pid}.part`;
}

/** Expand `~`, resolve, and refuse anything that is not a usable path string. */
export function normalizeRemotePath(value) {
  if (typeof value !== "string") {
    throw new Error("this action requires a `remotePath` string");
  }
  const raw = value.trim();
  if (!raw) {
    throw new Error("this action requires a `remotePath` string");
  }
  if (raw.includes(NUL)) {
    throw new Error("`remotePath` must not contain NUL bytes");
  }
  return path.resolve(expandHome(raw));
}

export function normalizeSha256(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

function normalizeSizeBytes(value, maxBytes) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("`sizeBytes` must be a non-negative integer");
  }
  if (parsed > maxBytes) {
    throw new Error(`\`sizeBytes\` ${parsed} is over this daemon's ${maxBytes} byte limit`);
  }
  return parsed;
}

function normalizeMode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("`mode` must be a file mode integer");
  }
  return parsed & 0o777;
}

function normalizeName(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes(NUL)) return "";
  // Only ever a single segment: the caller names a file, never a subtree.
  return path.basename(trimmed);
}

function requireId(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.includes(NUL)) {
    throw new Error(`this action requires a \`${field}\` string`);
  }
  return normalized;
}

function expandHome(raw) {
  if (raw === "~") {
    return resolveUserHome();
  }
  if (raw.startsWith("~/")) {
    return path.join(resolveUserHome(), raw.slice(2));
  }
  return raw;
}

async function statOrNull(target) {
  try {
    return await fsp.stat(target);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}

/** A missing partial is simply an offset of zero. */
async function fileSizeOrZero(target) {
  const info = await statOrNull(target);
  return info?.isFile() ? info.size : 0;
}

async function hashFile(filePath, signal) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath, signal ? { signal } : {})) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function toPositiveInt(value) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function toNonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseContentLength(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `bytes 10-19/20` -> `{ start: 10, end: 19, total: 20 }`. */
function parseContentRange(raw) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(raw ?? "").trim());
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === "*" ? null : Number(match[3]),
  };
}

/** A JSON body, or `null` for anything that is not one. */
async function readJsonBody(response) {
  try {
    if (typeof response?.json === "function") {
      return await response.json();
    }
    if (typeof response?.text === "function") {
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The server broke the protocol (wrong length, wrong range, more bytes than it
 * declared). Retrying cannot fix a server that is lying, and continuing would
 * mean writing bytes we cannot account for.
 */
function protocolError(message) {
  const error = new Error(message);
  error.permanent = true;
  return error;
}

/**
 * Which failures are worth another try. Network-level failures carry no status
 * at all — those are exactly the blips resume exists for. Among HTTP statuses
 * only 5xx, 408 and 429 can plausibly succeed on a second attempt; retrying a
 * 403, a 404, a 410 or a 413 just burns the caller's deadline.
 */
function httpError(what, status) {
  const retryable =
    status === undefined || status === null || status >= 500 || status === 408 || status === 429;
  const error = new Error(
    `${what} failed with HTTP ${status ?? "?"}${retryable ? "" : " (permanent)"}`,
  );
  error.permanent = !retryable;
  error.status = status ?? null;
  return error;
}

function errMsg(err) {
  return err?.message ?? String(err);
}
