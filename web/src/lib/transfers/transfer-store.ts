import fs from "node:fs/promises";
import nodeFs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type TransferDirection = "up" | "down";

/**
 * `staged`   — up: row exists, bytes not uploaded yet.
 * `requested`— down: row exists, the daemon has been asked to push.
 * `uploaded` — bytes are on the Web disk (either side).
 * `delivering`— up: the `pull` request is out on the wire.
 * `ready`    — up: the daemon wrote the file; down: bytes are fetchable.
 * `failed`   — terminal, `error` carries why.
 * `cancelled`— terminal, the caller gave up.
 */
export type TransferStatus =
  | "staged"
  | "requested"
  | "uploaded"
  | "delivering"
  | "ready"
  | "failed"
  | "cancelled";

export interface TransferRecord {
  transferId: string;
  userId: string;
  agentHost: string;
  direction: TransferDirection;
  remotePath: string;
  name: string;
  sizeBytes: number | null;
  sha256: string | null;
  mode: number | null;
  status: TransferStatus;
  error: string | null;
  /** Bytes durably on disk for this transfer. The resume cursor: a chunked
   *  PUT must start exactly here or it gets a 409 carrying this number. */
  receivedBytes: number;
  /** The full size the sender committed to, once anything has declared one
   *  (`sizeBytes` at create for an upload, `Content-Range`'s total otherwise).
   *  Completion is `receivedBytes === totalBytes`. */
  totalBytes: number | null;
  /** Disk budget held by this transfer while it is live. Charged at create
   *  time from the *declared* size — see `createTransfer`. */
  reservedBytes: number;
  /** Set once the staged blob has been unlinked ahead of the TTL sweep, which
   *  happens as soon as a delivered upload's bytes stop having a consumer. The
   *  record outlives its blob so the client's status poll still resolves. */
  blobReleased: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface CreateTransferInput {
  userId: string;
  agentHost: string;
  direction: TransferDirection;
  remotePath: string;
  name?: string | null;
  sizeBytes?: number | null;
  sha256?: string | null;
  mode?: number | null;
}

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
/** Every live transfer on this process, summed. Without it the per-file cap
 *  bounds nothing: N users × 4 concurrent × 1 GiB is unbounded disk. */
const DEFAULT_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
/** One user must not be able to eat the whole global budget. */
const DEFAULT_USER_BYTES = 2 * 1024 * 1024 * 1024;
/** Headroom the staging area must leave for the rest of the box (logs, DB,
 *  task attachments). Refuse the transfer rather than fill the disk. */
const MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024;
const TRANSFER_TTL_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60_000;
/** An unreferenced file this old can only have come from a process restart:
 *  the Map is gone but the bytes are not. */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/**
 * Bytes are heavier than exec output and each live transfer can pin up to
 * `CONDUCTOR_REMOTE_FILE_MAX_BYTES` of Web disk, so the per-user budget is
 * half of remote exec's.
 */
const MAX_LIVE_TRANSFERS_PER_USER = 4;

/** RFC 0037: no Prisma table. A transfer only has to outlive its own HTTP
 *  round trips, and `realtimeHub` already pins the feature to one process. */
const transfers = new Map<string, TransferRecord>();

function envBytes(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function remoteFileMaxBytes(): number {
  return envBytes("CONDUCTOR_REMOTE_FILE_MAX_BYTES", DEFAULT_MAX_BYTES);
}

/** Process-wide ceiling on staged bytes. */
export function remoteFileTotalBytes(): number {
  return envBytes("CONDUCTOR_REMOTE_FILE_TOTAL_BYTES", DEFAULT_TOTAL_BYTES);
}

/** Per-user slice of the global staging budget. */
export function remoteFileUserBytes(): number {
  return envBytes("CONDUCTOR_REMOTE_FILE_USER_BYTES", DEFAULT_USER_BYTES);
}

/** Resolved per call so a test (or a redeploy) can repoint the storage root
 *  without reloading the module. */
function storageRoot(): string {
  const base = path.resolve(
    process.env.CONDUCTOR_FILE_STORAGE_DIR || path.join(process.cwd(), ".conductor-data"),
  );
  return path.join(base, "remote-transfers");
}

function isSafeTransferId(transferId: string): boolean {
  return Boolean(transferId) && path.basename(transferId) === transferId && !transferId.startsWith(".");
}

function contentPath(transferId: string): string {
  return path.join(storageRoot(), `${transferId}.bin`);
}

function partPath(transferId: string): string {
  return path.join(storageRoot(), `${transferId}.part`);
}

function codedError(message: string, code: string, extra?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code }, extra ?? {});
}

/**
 * Whether a record still occupies one of the caller's concurrency slots.
 *
 * `ready` is terminal — the bytes are delivered (up) or staged and waiting to
 * be fetched (down) — so it must NOT count. Counting it turned a concurrency
 * cap into "4 transfers per TTL window": four one-second copies would lock the
 * user out of the feature, across every one of their hosts, until the janitor
 * ran. Disk is bounded separately, by the size cap and the TTL.
 */
function isLive(record: TransferRecord): boolean {
  return (
    record.status !== "ready"
    && record.status !== "failed"
    && record.status !== "cancelled"
  );
}

/**
 * Bytes currently spoken for, optionally scoped to one user.
 *
 * Counts the *reservation*, not what has landed: ten simultaneous creates
 * would each see "0 bytes written so far", all pass the check, and only then
 * collectively blow past the budget. `receivedBytes` is the floor for the
 * pathological case of a sender that under-declared and streamed more.
 */
function reservedBytes(userId?: string): number {
  let total = 0;
  for (const record of transfers.values()) {
    if (userId !== undefined && record.userId !== userId) continue;
    // Blob already unlinked: the record lingers only so the client's status
    // poll resolves, and a record with no bytes on disk must cost no budget.
    if (record.blobReleased) continue;
    if (isLive(record)) {
      total += Math.max(record.reservedBytes, record.receivedBytes);
      continue;
    }
    // A `ready` download is finished but its bytes stay on disk until the
    // client fetches them or the TTL sweep runs. Excluding it from the budget
    // while it still occupies the volume is how a disk fills up: the cap would
    // only bound work in progress, not storage. (A `ready` upload never gets
    // here — it releases its blob on delivery and is skipped above.)
    // `failed`/`cancelled` records have had their blobs removed, so they cost
    // nothing.
    if (record.status === "ready") total += record.receivedBytes;
  }
  return total;
}

/**
 * Free bytes on the volume holding the staging root, or `null` when the
 * platform cannot say. The root may not exist yet on a cold box, so walk up to
 * the nearest ancestor that does — it is the same filesystem.
 */
function freeDiskBytes(): number | null {
  if (typeof nodeFs.statfsSync !== "function") return null;
  let dir = storageRoot();
  for (let depth = 0; depth < 16; depth += 1) {
    try {
      const stat = nodeFs.statfsSync(dir);
      return stat.bavail * stat.bsize;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
  return null;
}

/** Test-only view of the budget accounting. */
export function remoteFileReservedBytesForTests(userId?: string): number {
  return reservedBytes(userId);
}

export function createTransfer(input: CreateTransferInput): TransferRecord {
  let live = 0;
  for (const record of transfers.values()) {
    if (record.userId === input.userId && isLive(record)) live += 1;
  }
  if (live >= MAX_LIVE_TRANSFERS_PER_USER) {
    throw codedError(
      `too many concurrent remote file transfers (limit ${MAX_LIVE_TRANSFERS_PER_USER}); retry shortly`,
      "TRANSFER_LIMIT",
    );
  }

  // A download's size is only known once the daemon has stat'ed the remote
  // file, so charge the worst case now and correct it in `writeTransferContent`
  // as soon as the real total shows up.
  const maxBytes = remoteFileMaxBytes();
  const reserve =
    input.direction === "up" && typeof input.sizeBytes === "number" ? input.sizeBytes : maxBytes;

  const totalBudget = remoteFileTotalBytes();
  if (reservedBytes() + reserve > totalBudget) {
    throw codedError(
      `remote file staging is full (limit ${totalBudget} bytes); retry shortly`,
      "TRANSFER_BUDGET",
    );
  }
  const userBudget = remoteFileUserBytes();
  if (reservedBytes(input.userId) + reserve > userBudget) {
    throw codedError(
      `remote file staging budget exhausted for this account (limit ${userBudget} bytes); ` +
        "finish or cancel a transfer and retry",
      "TRANSFER_BUDGET",
    );
  }
  const free = freeDiskBytes();
  if (free !== null && free - reserve < MIN_FREE_DISK_BYTES) {
    throw codedError("insufficient disk space for remote file staging", "TRANSFER_BUDGET");
  }

  const now = Date.now();
  const record: TransferRecord = {
    transferId: randomUUID(),
    userId: input.userId,
    agentHost: input.agentHost,
    direction: input.direction,
    remotePath: input.remotePath,
    name: input.name?.trim() || path.basename(input.remotePath) || "file",
    sizeBytes: input.sizeBytes ?? null,
    sha256: input.sha256 ?? null,
    mode: input.mode ?? null,
    status: input.direction === "up" ? "staged" : "requested",
    error: null,
    receivedBytes: 0,
    totalBytes: input.direction === "up" ? input.sizeBytes ?? null : null,
    reservedBytes: reserve,
    blobReleased: false,
    createdAt: now,
    expiresAt: now + TRANSFER_TTL_MS,
  };
  transfers.set(record.transferId, record);
  return record;
}

/**
 * Scoped by owner on purpose: `transferId` is the only thing in the URL, so
 * without this check any authenticated caller who learned an id could read
 * another tenant's staged bytes.
 */
export function getTransfer(transferId: string, userId: string): TransferRecord | null {
  const record = transfers.get(transferId);
  if (!record || record.userId !== userId) return null;
  return record;
}

export function updateTransfer(
  transferId: string,
  patch: Partial<Pick<TransferRecord, "status" | "error" | "sizeBytes" | "sha256" | "mode" | "name">>,
): TransferRecord | null {
  const record = transfers.get(transferId);
  if (!record) return null;
  Object.assign(record, patch);
  // A delivered upload's staged blob has no reader left: the daemon has
  // already written the bytes to `remotePath`, and the client only polls for
  // status from here. Holding it until the TTL sweep charged the user's
  // staging budget for storage that was doing nothing, so two 1 GiB copies
  // exhausted a 2 GiB budget and locked the account out of `remote cp`
  // entirely — at any size — for the rest of the window. Downloads are
  // different: `ready` there means "fetchable", so those bytes must stay.
  if (record.status === "ready" && record.direction === "up" && !record.blobReleased) {
    record.blobReleased = true;
    void releaseTransferBlob(record.transferId);
  }
  // Every state change is proof of progress, so restart the expiry clock.
  // With a fixed `createdAt + TTL` deadline, a 1 GiB upload on a slow link
  // could be swept — record dropped, blob unlinked — while the daemon was
  // still mid-download, and the daemon reads that 404 as permanent.
  record.expiresAt = Date.now() + TRANSFER_TTL_MS;
  return record;
}

export interface WriteTransferContentOptions {
  maxBytes: number;
  /**
   * Offset this chunk starts at, from `Content-Range`. `undefined` means the
   * request carried no `Content-Range` at all: a whole-body upload, which
   * restarts the blob from zero and completes when the stream ends.
   */
  start?: number;
  /** Total size from `Content-Range`. Required to know when a chunked upload
   *  is complete; `null` only for whole-body uploads. */
  total?: number | null;
}

export interface WriteTransferContentResult {
  receivedBytes: number;
  complete: boolean;
  /** Set only when `complete`, and measured over every persisted byte. */
  sizeBytes: number | null;
  sha256: string | null;
}

async function fileSize(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/** Hash of everything on disk — a chunked upload has no single stream to hash
 *  as it goes, and rehashing once at the end beats carrying rolling state. */
async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of nodeFs.createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/** Cut a part file back to a known-good length, creating it if absent. */
async function truncatePart(filePath: string, length: number): Promise<void> {
  try {
    const handle = await fs.open(filePath, "a", 0o600);
    try {
      await handle.truncate(length);
    } finally {
      await handle.close();
    }
  } catch {
    // Nothing to salvage; the next attempt starts from whatever is left, which
    // `fileSize` will report honestly.
  }
}

/** Transfers with a write in flight. Two chunks racing on one blob would both
 *  read the same offset, both pass the resume check and then overwrite each
 *  other — the second caller is told to resync instead. */
const writing = new Set<string>();

/**
 * Append one chunk (or a whole body) to a transfer's staging blob.
 *
 * Bytes accumulate in `<transferId>.part` and are only renamed to
 * `<transferId>.bin` once the declared total has arrived, so a reader can
 * never observe a half-assembled file.
 */
export async function writeTransferContent(
  transferId: string,
  stream: Readable,
  options: WriteTransferContentOptions,
): Promise<WriteTransferContentResult> {
  if (writing.has(transferId)) {
    throw codedError("another chunk for this transfer is still being written", "TRANSFER_OFFSET_MISMATCH", {
      receivedBytes: transfers.get(transferId)?.receivedBytes ?? 0,
    });
  }
  writing.add(transferId);
  try {
    return await writeTransferContentExclusive(transferId, stream, options);
  } finally {
    writing.delete(transferId);
  }
}

async function writeTransferContentExclusive(
  transferId: string,
  stream: Readable,
  options: WriteTransferContentOptions,
): Promise<WriteTransferContentResult> {
  if (!isSafeTransferId(transferId)) throw codedError("invalid transferId", "TRANSFER_NOT_FOUND");
  const root = storageRoot();
  const finalPath = path.join(root, `${transferId}.bin`);
  const temporaryPath = path.join(root, `${transferId}.part`);
  const record = transfers.get(transferId) ?? null;

  const { maxBytes } = options;
  const chunked = typeof options.start === "number";
  const total = options.total ?? null;

  if (total !== null && total > maxBytes) {
    throw codedError("file too large", "TRANSFER_TOO_LARGE");
  }
  // The size a client commits to must not drift between chunks, or the blob
  // would be renamed into place at a length nobody agreed on.
  if (total !== null && record?.totalBytes != null && record.totalBytes !== total) {
    throw codedError(
      `Content-Range total ${total} does not match the declared size ${record.totalBytes}`,
      "TRANSFER_TOTAL_MISMATCH",
    );
  }

  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);

  let offset = 0;
  if (chunked) {
    const onDisk = (await fileSize(temporaryPath)) ?? 0;
    const ledger = record ? record.receivedBytes : onDisk;
    if (record && record.totalBytes !== null && ledger >= record.totalBytes) {
      // Already assembled and renamed away: a late duplicate of the final
      // chunk, not a resume.
      throw codedError("transfer content is already complete", "TRANSFER_OFFSET_MISMATCH", {
        receivedBytes: ledger,
      });
    }
    // The record is the ledger, the part file is the storage. They only differ
    // after a crash, and then the shorter of the two is the honest answer.
    offset = Math.min(ledger, onDisk);
    if (record) record.receivedBytes = offset;
    if (options.start !== offset) {
      throw codedError(
        `chunk starts at ${options.start} but ${offset} bytes have been received`,
        "TRANSFER_OFFSET_MISMATCH",
        { receivedBytes: offset },
      );
    }
    // Drop any tail left by an interrupted write so the append lands exactly
    // at `offset`. Unconditional: it also creates the file that `r+` below
    // needs to already exist when this is the first chunk.
    await truncatePart(temporaryPath, offset);
  }

  // A whole-body upload is a single pass, so hash it as it streams; a chunked
  // one is rehashed from disk when the last chunk lands.
  const hash = chunked ? null : createHash("sha256");
  let chunkBytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      chunkBytes += chunk.byteLength;
      if (offset + chunkBytes > maxBytes) {
        callback(codedError("file too large", "TRANSFER_TOO_LARGE"));
        return;
      }
      if (total !== null && offset + chunkBytes > total) {
        callback(codedError("chunk runs past the declared total", "TRANSFER_RANGE_INVALID"));
        return;
      }
      hash?.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    // `w` for a whole body (a retried PUT should overwrite an abandoned part
    // file rather than fail forever); `r+` at an explicit offset to append a
    // chunk without trusting the OS append cursor.
    const sink = chunked
      ? nodeFs.createWriteStream(temporaryPath, { flags: "r+", mode: 0o600, start: offset })
      : nodeFs.createWriteStream(temporaryPath, { flags: "w", mode: 0o600 });
    await pipeline(stream, meter, sink);
  } catch (error) {
    if (chunked) {
      // Roll back to the last acknowledged offset. Leaving a half-written
      // chunk appended would make `receivedBytes` a lie and corrupt the resume.
      await truncatePart(temporaryPath, offset);
      if (record) record.receivedBytes = offset;
    } else {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      if (record) record.receivedBytes = 0;
    }
    throw error;
  }

  const receivedBytes = offset + chunkBytes;
  const complete = total === null ? !chunked : receivedBytes >= total;

  if (record) {
    record.receivedBytes = receivedBytes;
    if (total !== null) {
      record.totalBytes = total;
      // The worst-case reservation taken at create time can now shrink to the
      // real size, handing the difference back to the budget.
      record.reservedBytes = Math.max(Math.min(record.reservedBytes, total), receivedBytes);
    }
    // Bytes landing is progress, so the janitor must not sweep mid-transfer.
    record.expiresAt = Date.now() + TRANSFER_TTL_MS;
  }

  if (!complete) {
    return { receivedBytes, complete: false, sizeBytes: null, sha256: null };
  }

  const sha256 = hash ? hash.digest("hex") : await hashFile(temporaryPath);
  try {
    // Never expose a half-written body: rename is atomic within the root.
    await fs.rename(temporaryPath, finalPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    if (record) record.receivedBytes = 0;
    throw error;
  }
  if (record) {
    record.totalBytes = receivedBytes;
    record.reservedBytes = receivedBytes;
  }
  return { receivedBytes, complete: true, sizeBytes: receivedBytes, sha256 };
}

export interface OpenedTransferContent {
  stream: nodeFs.ReadStream;
  /** Bytes this stream will yield — the whole blob unless a range was asked for. */
  sizeBytes: number;
  /** Size of the staged blob, whatever slice of it is being served. */
  totalBytes: number;
  /** Inclusive bounds of the slice being served. */
  start: number;
  end: number;
  partial: boolean;
}

export interface UnsatisfiableTransferRange {
  unsatisfiable: true;
  totalBytes: number;
}

export async function openTransferContent(
  transferId: string,
  range?: { start: number; end?: number | null } | null,
): Promise<OpenedTransferContent | UnsatisfiableTransferRange | null> {
  if (!isSafeTransferId(transferId)) return null;
  const filePath = contentPath(transferId);
  let totalBytes: number;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    totalBytes = stat.size;
  } catch {
    return null;
  }

  if (!range) {
    return {
      stream: nodeFs.createReadStream(filePath),
      sizeBytes: totalBytes,
      totalBytes,
      start: 0,
      end: Math.max(totalBytes - 1, 0),
      partial: false,
    };
  }

  const start = range.start;
  if (!Number.isInteger(start) || start < 0 || start >= totalBytes) {
    return { unsatisfiable: true, totalBytes };
  }
  const requestedEnd = typeof range.end === "number" ? range.end : totalBytes - 1;
  const end = Math.min(requestedEnd, totalBytes - 1);
  if (end < start) return { unsatisfiable: true, totalBytes };

  return {
    stream: nodeFs.createReadStream(filePath, { start, end }),
    sizeBytes: end - start + 1,
    totalBytes,
    start,
    end,
    partial: true,
  };
}

/** Drop a transfer's bytes while keeping its record. */
async function releaseTransferBlob(transferId: string): Promise<void> {
  if (!isSafeTransferId(transferId)) return;
  await fs.rm(contentPath(transferId), { force: true }).catch(() => undefined);
  await fs.rm(partPath(transferId), { force: true }).catch(() => undefined);
}

export async function deleteTransfer(transferId: string): Promise<void> {
  transfers.delete(transferId);
  if (!isSafeTransferId(transferId)) return;
  await fs.rm(contentPath(transferId), { force: true }).catch(() => undefined);
  await fs.rm(partPath(transferId), { force: true }).catch(() => undefined);
}

export async function pruneExpiredTransfers(now = Date.now()): Promise<number> {
  let deleted = 0;
  for (const record of [...transfers.values()]) {
    if (record.expiresAt > now) continue;
    await deleteTransfer(record.transferId);
    deleted += 1;
  }
  return deleted;
}

/**
 * The registry is in-process, so a restart drops every record while its bytes
 * stay on disk. Reclaim anything the Map does not claim once it is old enough
 * that no in-flight request could still be writing it.
 */
export async function pruneOrphanedTransferFiles(now = Date.now()): Promise<number> {
  const root = storageRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return 0;
  }

  let pruned = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".bin") && !entry.endsWith(".part")) continue;
    const transferId = entry.replace(/\.(bin|part)$/, "");
    if (transfers.has(transferId)) continue;
    const filePath = path.join(root, entry);
    try {
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs < ORPHAN_GRACE_MS) continue;
      await fs.rm(filePath, { force: true });
      pruned += 1;
    } catch {
      continue;
    }
  }
  return pruned;
}

export function startTransferJanitor(log: Pick<Console, "info" | "error"> = console): NodeJS.Timeout {
  const timer = setInterval(() => {
    void (async () => {
      const expired = await pruneExpiredTransfers();
      if (expired > 0) log.info?.(`[transfers] pruned ${expired} expired transfer(s)`);
      const orphans = await pruneOrphanedTransferFiles();
      if (orphans > 0) log.info?.(`[transfers] pruned ${orphans} orphaned transfer file(s)`);
    })().catch((error) => {
      log.error?.(`[transfers] sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

/** `Content-Range: bytes <start>-<end>/<total>`. Anything else — including the
 *  `*` forms, which cannot tell us when the upload is done — is rejected so the
 *  caller answers 400 instead of silently mis-assembling a file. */
export function parseContentRange(
  header: string | null | undefined,
): { start: number; end: number; total: number } | null {
  if (!header) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) {
    return null;
  }
  if (start > end || end >= total) return null;
  return { start, end, total };
}

/** `Range: bytes=<start>-` / `bytes=<start>-<end>`. Suffix and multi-range
 *  requests are not supported; returning `null` makes the caller serve the
 *  whole body, which is what RFC 9110 asks of a server that ignores a Range. */
export function parseRangeHeader(
  header: string | null | undefined,
): { start: number; end: number | null } | null {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start)) return null;
  if (!match[2]) return { start, end: null };
  const end = Number(match[2]);
  if (!Number.isSafeInteger(end)) return null;
  return { start, end };
}

/** Test-only: drop every record so a suite can start from a clean registry. */
export function resetTransferStoreForTests(): void {
  transfers.clear();
}
