/**
 * `conductor remote cp` — copy one file between here and another daemon's host.
 *
 * Follows scp's shape: exactly one of the two paths carries a `daemon:` prefix,
 * and that decides the direction. The bytes never travel over the agent
 * WebSocket — they go through two ordinary HTTP streams via the backend, which
 * only relays a small control message on the socket. See RFC 0037.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  EXIT,
  UsageError,
  callApi,
  delay,
  getStream,
  isRetryable,
  loadCliConfig,
  parseTimeoutMs as parseSharedTimeoutMs,
  putStream,
  withRetry,
} from "./client.js";
import { execRemoteOrThrow } from "./exec.js";
import {
  CLEANUP_SCRIPT,
  EXTRACT_SCRIPT,
  PACK_SCRIPT,
  localTempPath,
  packLocalDirectory,
  remoteTempPath,
  shellArgs,
  unpackLocalDirectory,
} from "./archive.js";

export { EXIT, UsageError };

/**
 * 1 GiB on a 5 Mbit/s uplink is roughly 27 minutes, and cutting a transfer off
 * mid-flight is worse than letting a slow one finish — especially now that a
 * stalled chunk is retried rather than fatal. `--timeout` remains the overall
 * deadline for anyone who wants a tighter one.
 */
const DEFAULT_TIMEOUT_MS = 1_800_000;

/**
 * One request carries at most this much.
 *
 * Chunking is what makes a transfer resumable, and it is also what keeps the
 * server safe at a 1 GiB file limit: a single request is bounded in duration
 * and in how much any proxy in the path has to hold, so nginx's body cap can
 * stay small and a failure costs one chunk instead of the whole file.
 */
const DEFAULT_CHUNK_BYTES = 32 * 1024 * 1024;

/** Overridable so a flaky link can shrink it — and so tests can exercise the
 *  multi-chunk path without moving 32 MiB around. */
export function chunkBytes(env = process.env) {
  const raw = Number.parseInt(env.CONDUCTOR_REMOTE_CHUNK_BYTES || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CHUNK_BYTES;
}

const VALUE_FLAGS = new Map([
  ["--target", "target"],
  ["-t", "target"],
  ["--timeout", "timeout"],
  ["--config-file", "configFile"],
]);

const BOOL_FLAGS = new Map([
  ["--json", "json"],
  ["--recursive", "recursive"],
  ["-r", "recursive"],
  ["--help", "help"],
  ["-h", "help"],
]);

export function parseCpArgs(argv) {
  const options = { json: false, help: false, recursive: false };
  const paths = [];

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];

    if (token === "--") {
      paths.push(...argv.slice(index + 1));
      break;
    }

    let name = token;
    let inlineValue = null;
    if (token.startsWith("--") && token.includes("=")) {
      const splitAt = token.indexOf("=");
      name = token.slice(0, splitAt);
      inlineValue = token.slice(splitAt + 1);
    }

    if (BOOL_FLAGS.has(name) && inlineValue === null) {
      options[BOOL_FLAGS.get(name)] = true;
      index += 1;
      continue;
    }

    if (VALUE_FLAGS.has(name)) {
      const key = VALUE_FLAGS.get(name);
      const value = inlineValue !== null ? inlineValue : argv[index + 1];
      if (value === undefined) {
        throw new UsageError(`${name} requires a value`);
      }
      options[key] = value;
      index += inlineValue !== null ? 1 : 2;
      continue;
    }

    if (name.startsWith("-") && name !== "-") {
      throw new UsageError(`unknown option: ${token}`);
    }

    paths.push(token);
    index += 1;
  }

  return { options, paths };
}

export function parseTimeoutMs(value) {
  return parseSharedTimeoutMs(value, DEFAULT_TIMEOUT_MS);
}

/**
 * Decide whether a path argument names a daemon.
 *
 * `daemon:/path` and `:/path` (with `--target`) are remote; anything starting
 * with `/`, `.` or `~` is local even when it contains a colon, so a local file
 * literally named `a:b` stays reachable as `./a:b`.
 */
export function parseRemoteSpec(value, defaultTarget) {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  if (value.startsWith("/") || value.startsWith(".") || value.startsWith("~")) {
    return null;
  }
  const match = value.match(/^([^:/]*):(.+)$/);
  if (!match) {
    return null;
  }
  const target = (match[1] || defaultTarget || "").trim();
  if (!target) {
    throw new UsageError(`no daemon in "${value}" and no --target given`);
  }
  return { target, path: match[2] };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "? B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function hashLocalFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function showHelp(consoleImpl = console) {
  consoleImpl.log(`conductor remote cp - copy a file to or from another daemon's host

Usage:
  conductor remote cp [options] <src> <dst>

Exactly one of <src> and <dst> must name a daemon as <daemon>:<path>.

Options:
  -r, --recursive         Copy a directory and everything under it
  -t, --target <daemon>   Daemon to use when a path is written as :<path>
      --timeout <dur>     Overall deadline, e.g. 30s, 5m (default: 30m)
      --json              Print the raw transfer result as JSON
      --config-file <p>   Conductor config file to authenticate with
  -h, --help              Show this help

Notes:
  Contents are verified end to end with SHA-256, and the destination is written
  via a temporary file and renamed, so an interrupted copy never leaves a
  half-written file in place.

  -r packs the directory with tar, moves the single tarball, and unpacks it on
  the other side, so permissions and symlinks survive. It needs tar and the
  remote_exec capability on the target, and the *compressed* size must fit under
  the transfer limit. Like scp: an existing destination directory receives the
  source inside it, a missing one becomes the copy itself.

Examples:
  conductor remote cp ./build.tar.gz ubuntu:/srv/app/build.tar.gz
  conductor remote cp ubuntu:/var/log/conductor.log ./conductor.log
  conductor remote cp -r ./dist ubuntu:/srv/app        # -> /srv/app/dist
  conductor remote cp -r ubuntu:/srv/app/logs ./logs   # -> ./logs
  conductor remote cp -t ubuntu ./a.bin :/tmp/a.bin
`);
}

/**
 * Send a file as a sequence of ranged PUTs, resuming across failures.
 *
 * The server owns the truth about how much it has: a 409 carries the real
 * `receivedBytes`, and we seek there rather than failing. That single rule
 * covers both a mid-transfer retry and a chunk the server only half-accepted.
 */
const POLL_INTERVAL_MS = 1_000;
const TERMINAL_STATUSES = new Set(["ready", "failed", "cancelled"]);

/**
 * Wait for a transfer the daemon is still working on.
 *
 * Moving real bytes takes far longer than any HTTP request should be held
 * open: a 1 GiB pull outlives both nginx's 60s read timeout and the backend's
 * websocket wait. So the backend answers as soon as it knows the daemon has
 * *started*, and we poll for the outcome — the same two-phase shape
 * `remote exec` already uses for long commands.
 */
async function awaitTransfer({
  config, statusPath, initial, fetchImpl, deadline, sleep = delay, now = () => Date.now(),
}) {
  let record = initial;
  while (!TERMINAL_STATUSES.has(record?.status)) {
    if (typeof deadline === "number" && now() >= deadline) {
      throw new Error(`transfer did not finish before the deadline (last status: ${record?.status})`);
    }
    await sleep(POLL_INTERVAL_MS);
    try {
      record = await callApi(config, "GET", statusPath, null, fetchImpl);
    } catch (error) {
      // One failed poll must not abort a transfer that is still healthy; the
      // deadline above is what ends it.
      if (!isRetryable(error)) throw error;
    }
  }
  if (record.status !== "ready") {
    throw new Error(record.error || `transfer ${record.status}`);
  }
  return record;
}

/** Show progress on stderr for transfers large enough that silence looks hung. */
function makeProgress(consoleImpl, label, quiet) {
  const MIN_BYTES = 8 * 1024 * 1024;
  const INTERVAL_MS = 1000;
  let lastAt = 0;
  return (done, total) => {
    if (quiet || !Number.isFinite(total) || total < MIN_BYTES) return;
    const now = Date.now();
    const finished = done >= total;
    if (!finished && now - lastAt < INTERVAL_MS) return;
    lastAt = now;
    const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
    // \r keeps it on one line; the caller prints a real line when it finishes.
    process.stderr.write(
      `\r[conductor] ${label} ${formatBytes(done)}/${formatBytes(total)} (${pct}%)${finished ? "\n" : ""}`,
    );
  };
}

async function uploadChunks({
  config, contentPath, filePath, totalBytes, fetchImpl, signal, sleep = delay, onProgress, env,
}) {
  const chunk = chunkBytes(env);
  let offset = 0;
  let result = null;

  // A zero-byte file still needs one request to mark the transfer complete.
  while (offset < totalBytes || (totalBytes === 0 && !result)) {
    result = await withRetry(async () => {
      // Recompute the range on every attempt. A retry may be happening
      // *because* the server told us our offset was stale, so re-sending the
      // range we captured before would just earn another 409.
      const start = offset;
      const end = Math.min(start + chunk, totalBytes) - 1;
      try {
        return await putStream(
          config,
          contentPath,
          Readable.toWeb(
            totalBytes === 0
              ? Readable.from([])
              : fs.createReadStream(filePath, { start, end }),
          ),
          {
            sizeBytes: totalBytes === 0 ? 0 : end - start + 1,
            // An empty file has no satisfiable byte range at all (`bytes 0-0/0`
            // is malformed, and `0--1/0` is nonsense), so send it as a plain
            // whole-body PUT and let the server record a complete zero-byte
            // transfer.
            ...(totalBytes === 0
              ? {}
              : { contentRange: `bytes ${start}-${end}/${totalBytes}` }),
            fetchImpl,
            signal,
          },
        );
      } catch (error) {
        // Not really a failure: the server is telling us where it actually is.
        // Move there and let `withRetry` take another pass.
        if (error?.status === 409 && typeof error.receivedBytes === "number") {
          offset = error.receivedBytes;
          throw Object.assign(error, { status: 503 });
        }
        throw error;
      }
    }, { sleep });

    const advanced = typeof result?.receivedBytes === "number"
      ? result.receivedBytes
      : Math.min(offset + chunk, totalBytes);
    if (advanced <= offset && totalBytes > 0) {
      throw new Error(`upload stalled at ${offset}/${totalBytes} bytes`);
    }
    offset = advanced;
    onProgress?.(offset, totalBytes);
    if (result?.complete || totalBytes === 0) break;
  }

  return result;
}

/**
 * Pull a file down, resuming from whatever is already in the local `.part`.
 *
 * The hash has to be computed over the finished file rather than streamed,
 * because a resumed download never sees the earlier bytes go past.
 */
async function downloadChunks({
  config, contentPath, temporary, expectedBytes, fetchImpl, signal, sleep = delay, onProgress,
}) {
  await withRetry(async () => {
    const have = await fsp.stat(temporary).then((st) => st.size).catch(() => 0);
    if (Number.isFinite(expectedBytes) && have >= expectedBytes) return;

    const response = await getStream(config, contentPath, { fetchImpl, signal, rangeFrom: have });

    // 416 means the server has nothing past what we already hold.
    if (response.status === 416) return;

    // A server that ignored our Range restarts the file, so our partial is
    // stale and must go — appending to it would interleave two copies.
    const resuming = response.status === 206 && have > 0;
    if (!resuming && have > 0) {
      await fsp.rm(temporary, { force: true });
    }
    if (!response.body) throw new Error("backend returned an empty body");

    await pipeline(
      Readable.fromWeb(response.body),
      fs.createWriteStream(temporary, { flags: resuming ? "a" : "w", mode: 0o600 }),
    );

    const now = await fsp.stat(temporary).then((st) => st.size).catch(() => 0);
    onProgress?.(now, expectedBytes);
    if (Number.isFinite(expectedBytes) && now < expectedBytes) {
      // Ran short: throw so `withRetry` resumes from the new offset.
      throw new Error(`transfer ended early at ${now}/${expectedBytes} bytes`);
    }
  }, { sleep });
}

async function uploadFile(ctx) {
  const { config, target, localPath, remotePath, fetchImpl, consoleImpl, signal, quiet } = ctx;
  const resolvedLocal = path.resolve(expandHome(localPath));

  let stat;
  try {
    stat = await fsp.stat(resolvedLocal);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new UsageError(`no such file: ${resolvedLocal}`);
    }
    throw error;
  }
  if (stat.isDirectory()) {
    throw new UsageError(
      `${resolvedLocal} is a directory; pass -r to copy it recursively`,
    );
  }
  if (!stat.isFile()) {
    throw new UsageError(`not a regular file: ${resolvedLocal}`);
  }

  const sha256 = await hashLocalFile(resolvedLocal);
  const basePath = `/api/agents/${encodeURIComponent(target)}/files`;

  const created = await callApi(config, "POST", basePath, {
    direction: "up",
    remotePath,
    name: path.basename(resolvedLocal),
    sizeBytes: stat.size,
    sha256,
    mode: stat.mode & 0o777,
  }, fetchImpl);

  const transferId = created?.transferId;
  if (!transferId) {
    throw new Error("backend did not return a transferId");
  }

  await uploadChunks({
    config,
    contentPath: `${basePath}/${encodeURIComponent(transferId)}/content`,
    filePath: resolvedLocal,
    totalBytes: stat.size,
    fetchImpl,
    signal,
    sleep: ctx.sleep,
    onProgress: ctx.onProgress || makeProgress(consoleImpl, `uploading to ${target}:`, quiet),
    env: ctx.env,
  });

  let delivered = await callApi(
    config,
    "POST",
    `${basePath}/${encodeURIComponent(transferId)}/deliver`,
    {},
    fetchImpl,
  );

  // A daemon-side failure comes back as HTTP 200 with `status: "failed"`,
  // because the request itself succeeded — only the transfer did not.
  if (delivered?.status === "failed" || delivered?.error) {
    throw new Error(delivered?.error || `transfer failed on ${target}`);
  }
  // ...and a large file is still being written when `deliver` answers.
  delivered = await awaitTransfer({
    config,
    statusPath: `${basePath}/${encodeURIComponent(transferId)}`,
    initial: delivered,
    fetchImpl,
    deadline: ctx.deadline,
    sleep: ctx.sleep,
  });
  if (!quiet) {
    consoleImpl.error(
      `[conductor] uploaded ${formatBytes(stat.size)} to ${target}:${delivered?.path || remotePath}`,
    );
  }
  return { ...delivered, transferId, direction: "up", sizeBytes: stat.size, sha256 };
}

async function downloadFile(ctx) {
  const { config, target, remotePath, localPath, fetchImpl, consoleImpl, signal, quiet } = ctx;
  const basePath = `/api/agents/${encodeURIComponent(target)}/files`;

  let created = await callApi(config, "POST", basePath, {
    direction: "down",
    remotePath,
  }, fetchImpl);

  if (created?.status === "failed" || created?.error) {
    throw new Error(created?.error || `${target} could not read ${remotePath}`);
  }
  const transferId = created?.transferId;
  if (!transferId) {
    throw new Error("backend did not return a transferId");
  }
  // For anything but a small file the daemon is still uploading at this point.
  created = await awaitTransfer({
    config,
    statusPath: `${basePath}/${encodeURIComponent(transferId)}`,
    initial: created,
    fetchImpl,
    deadline: ctx.deadline,
    sleep: ctx.sleep,
  });

  // scp semantics: copying onto an existing directory keeps the source name.
  let destination = path.resolve(expandHome(localPath));
  try {
    const destStat = await fsp.stat(destination);
    if (destStat.isDirectory()) {
      destination = path.join(destination, created.name || path.basename(remotePath));
    }
  } catch {
    // Missing destination is the normal case; the parent must exist though.
  }

  // Check the parent before pulling any bytes: failing afterwards would waste
  // the whole transfer, and the raw ENOENT names the internal `.part` file,
  // which tells the user nothing about what is actually wrong.
  const parent = path.dirname(destination);
  try {
    const parentStat = await fsp.stat(parent);
    if (!parentStat.isDirectory()) {
      throw new UsageError(`not a directory: ${parent}`);
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if (error?.code === "ENOENT") {
      throw new UsageError(`destination directory does not exist: ${parent}`);
    }
    throw error;
  }

  // Demand the checksum and size up front rather than verifying them only when
  // present. A conditional check is worse than none: if the backend ever stops
  // sending the field, `undefined` quietly satisfies the guard and every
  // corrupt download is renamed into place with exit code 0. That bug shipped
  // once already. Checking before the transfer also avoids wasting it.
  if (!created.sha256) {
    throw new Error("backend did not report a checksum; refusing to write an unverified file");
  }
  if (!Number.isFinite(created.sizeBytes)) {
    throw new Error("backend did not report a size; refusing to write an unverified file");
  }

  const temporary = `${destination}.${process.pid}.part`;
  let received = 0;
  try {
    await downloadChunks({
      config,
      contentPath: `${basePath}/${encodeURIComponent(transferId)}/content`,
      temporary,
      expectedBytes: created.sizeBytes,
      fetchImpl,
      signal,
      sleep: ctx.sleep,
      onProgress: ctx.onProgress || makeProgress(consoleImpl, `downloading from ${target}:`, quiet),
    });

    // Hash the assembled file, not the stream: a resumed download never sees
    // the earlier bytes go by, so a streaming digest would cover only the last
    // range and would happily "verify" a spliced-together mess.
    received = (await fsp.stat(temporary)).size;
    if (received !== created.sizeBytes) {
      throw new Error(`size mismatch: expected ${created.sizeBytes} bytes, got ${received}`);
    }
    const digest = await hashLocalFile(temporary);
    if (digest !== created.sha256) {
      throw new Error(`checksum mismatch: expected ${created.sha256}, got ${digest}`);
    }

    await fsp.rename(temporary, destination);
    if (Number.isInteger(created.mode)) {
      await fsp.chmod(destination, created.mode & 0o777).catch(() => {});
    }
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }

  // Best effort: the server also reclaims this on a timer, but returning the
  // slot now is what keeps four quick copies in a row from hitting the cap.
  await callApi(config, "DELETE", `${basePath}/${encodeURIComponent(transferId)}`, null, fetchImpl)
    .catch(() => {});

  if (!quiet) {
    consoleImpl.error(
      `[conductor] downloaded ${formatBytes(received)} from ${target}:${remotePath} to ${destination}`,
    );
  }
  return { ...created, transferId, direction: "down", sizeBytes: received, path: destination };
}

/**
 * Budget for one remote `tar` step, always clamped to what is left of the
 * caller's own `--timeout`. Without the clamp `--timeout 30s` would still let a
 * pack run for minutes, because the archive steps go through `exec`, which has
 * its own deadline and knows nothing about ours.
 */
const ARCHIVE_STEP_TIMEOUT_MS = 600_000;

function archiveTimeout(ctx) {
  const remaining = typeof ctx.deadline === "number" ? ctx.deadline - Date.now() : Infinity;
  const budget = Math.min(ARCHIVE_STEP_TIMEOUT_MS, remaining);
  if (budget <= 0) throw new Error("ran out of time before the archive step");
  return budget;
}

async function uploadDirectory(ctx) {
  const { config, target, localPath, remotePath, fetchImpl, consoleImpl, signal, env } = ctx;
  const source = path.resolve(expandHome(localPath));
  const baseName = path.basename(source);
  const tarball = localTempPath();
  const remoteTarball = remoteTempPath(env);

  consoleImpl.error(`[conductor] packing ${source}`);
  await packLocalDirectory(source, tarball);

  try {
    const uploaded = await uploadFile({
      ...ctx,
      localPath: tarball,
      remotePath: remoteTarball,
      quiet: true,
    });

    consoleImpl.error(`[conductor] unpacking on ${target}`);
    await execRemoteOrThrow(config, target, "sh", {
      args: shellArgs(EXTRACT_SCRIPT, remoteTarball, remotePath, baseName),
      timeoutMs: archiveTimeout(ctx),
      fetchImpl,
    });

    consoleImpl.error(
      `[conductor] copied ${baseName}/ (${formatBytes(uploaded.sizeBytes)} compressed) to ${target}:${remotePath}`,
    );
    return { ...uploaded, direction: "up", recursive: true, path: remotePath };
  } finally {
    await fsp.rm(tarball, { force: true }).catch(() => {});
    // Best effort: leaving a tarball in the target's /tmp is untidy, but it
    // must never turn a completed copy into a failure.
    await execRemoteOrThrow(config, target, "sh", {
      args: shellArgs(CLEANUP_SCRIPT, remoteTarball),
      timeoutMs: 30_000,
      fetchImpl,
    }).catch(() => {});
  }
}

async function downloadDirectory(ctx) {
  const { config, target, remotePath, localPath, fetchImpl, consoleImpl, env } = ctx;
  const baseName = path.basename(remotePath.replace(/\/+$/, "")) || "download";
  const tarball = localTempPath();
  const remoteTarball = remoteTempPath(env);

  consoleImpl.error(`[conductor] packing ${target}:${remotePath}`);
  try {
    await execRemoteOrThrow(config, target, "sh", {
      args: shellArgs(PACK_SCRIPT, remotePath, remoteTarball),
      timeoutMs: archiveTimeout(ctx),
      fetchImpl,
    });

    const downloaded = await downloadFile({
      ...ctx,
      remotePath: remoteTarball,
      localPath: tarball,
      quiet: true,
    });

    const destination = await unpackLocalDirectory(
      tarball,
      path.resolve(expandHome(localPath)),
      baseName,
    );
    consoleImpl.error(
      `[conductor] copied ${baseName}/ (${formatBytes(downloaded.sizeBytes)} compressed) to ${destination}`,
    );
    return { ...downloaded, direction: "down", recursive: true, path: destination };
  } finally {
    await fsp.rm(tarball, { force: true }).catch(() => {});
    await execRemoteOrThrow(config, target, "sh", {
      args: shellArgs(CLEANUP_SCRIPT, remoteTarball),
      timeoutMs: 30_000,
      fetchImpl,
    }).catch(() => {});
  }
}

export async function runRemoteCp(argv, deps = {}) {
  const consoleImpl = deps.console || console;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const env = deps.env || process.env;
  const sleep = deps.sleep || delay;

  let parsed;
  try {
    parsed = parseCpArgs(argv);
  } catch (error) {
    consoleImpl.error(`Error: ${error.message}`);
    return EXIT.CLI_ERROR;
  }
  const { options, paths } = parsed;

  if (options.help) {
    showHelp(consoleImpl);
    return EXIT.OK;
  }

  if (paths.length !== 2) {
    consoleImpl.error(
      paths.length < 2
        ? "Error: need both a source and a destination"
        : `Error: expected exactly 2 paths, got ${paths.length}`,
    );
    showHelp(consoleImpl);
    return EXIT.CLI_ERROR;
  }

  let sourceSpec;
  let destSpec;
  let timeoutMs;
  try {
    sourceSpec = parseRemoteSpec(paths[0], options.target);
    destSpec = parseRemoteSpec(paths[1], options.target);
    timeoutMs = parseTimeoutMs(options.timeout);
  } catch (error) {
    consoleImpl.error(`Error: ${error.message}`);
    return EXIT.CLI_ERROR;
  }

  if (sourceSpec && destSpec) {
    consoleImpl.error("Error: daemon-to-daemon copy is not supported; one side must be local");
    return EXIT.CLI_ERROR;
  }
  if (!sourceSpec && !destSpec) {
    consoleImpl.error("Error: one side must name a daemon as <daemon>:<path>");
    showHelp(consoleImpl);
    return EXIT.CLI_ERROR;
  }

  let config;
  try {
    config = deps.config || loadCliConfig(options.configFile, env);
  } catch (error) {
    consoleImpl.error(`Error: ${error.message}`);
    return EXIT.CLI_ERROR;
  }

  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  const ctx = destSpec
    ? {
      config,
      target: destSpec.target,
      localPath: paths[0],
      remotePath: destSpec.path,
      fetchImpl,
      consoleImpl,
      env,
      sleep,
      deadline,
      signal: controller.signal,
    }
    : {
      config,
      target: sourceSpec.target,
      remotePath: sourceSpec.path,
      localPath: paths[1],
      fetchImpl,
      consoleImpl,
      env,
      sleep,
      deadline,
      signal: controller.signal,
    };

  try {
    let result;
    if (destSpec) {
      // scp does the same: -r on a plain file is just a copy, not an error.
      const sourceIsDirectory = options.recursive
        && (await fsp.stat(path.resolve(expandHome(paths[0]))).catch(() => null))?.isDirectory();
      result = sourceIsDirectory ? await uploadDirectory(ctx) : await uploadFile(ctx);
    } else if (options.recursive) {
      result = await downloadDirectory(ctx);
    } else {
      result = await downloadFile(ctx);
    }

    if (options.json) {
      consoleImpl.log(JSON.stringify(result, null, 2));
    }
    return EXIT.OK;
  } catch (error) {
    const message = controller.signal.aborted
      ? `transfer timed out after ${timeoutMs}ms`
      : error.message;
    consoleImpl.error(`Error: ${message}`);
    return EXIT.CLI_ERROR;
  } finally {
    clearTimeout(timer);
  }
}
