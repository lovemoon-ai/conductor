import fs from "node:fs/promises";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTransfer,
  deleteTransfer,
  getTransfer,
  openTransferContent,
  parseContentRange,
  parseRangeHeader,
  pruneExpiredTransfers,
  pruneOrphanedTransferFiles,
  remoteFileMaxBytes,
  remoteFileTotalBytes,
  remoteFileUserBytes,
  remoteFileReservedBytesForTests,
  resetTransferStoreForTests,
  updateTransfer,
  writeTransferContent,
} from "./transfer-store";

let root = "";
const originalStorageDir = process.env.CONDUCTOR_FILE_STORAGE_DIR;
const BUDGET_ENV = [
  "CONDUCTOR_REMOTE_FILE_MAX_BYTES",
  "CONDUCTOR_REMOTE_FILE_TOTAL_BYTES",
  "CONDUCTOR_REMOTE_FILE_USER_BYTES",
] as const;
const originalBudgetEnv = new Map(BUDGET_ENV.map((key) => [key, process.env[key]]));

const stagingDir = () => path.join(root, "remote-transfers");
const partFile = (transferId: string) => path.join(stagingDir(), `${transferId}.part`);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "conductor-transfers-"));
  process.env.CONDUCTOR_FILE_STORAGE_DIR = root;
  resetTransferStoreForTests();
});

afterEach(async () => {
  resetTransferStoreForTests();
  if (originalStorageDir === undefined) delete process.env.CONDUCTOR_FILE_STORAGE_DIR;
  else process.env.CONDUCTOR_FILE_STORAGE_DIR = originalStorageDir;
  for (const key of BUDGET_ENV) {
    const previous = originalBudgetEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  await fs.rm(root, { recursive: true, force: true });
});

const baseInput = {
  userId: "user-1",
  agentHost: "ubuntu",
  direction: "up" as const,
  remotePath: "/srv/app/a.tar",
};

describe("createTransfer", () => {
  it("starts an upload staged and a download requested, with a 15 minute expiry", () => {
    const up = createTransfer(baseInput);
    const down = createTransfer({ ...baseInput, direction: "down", remotePath: "/var/log/x.log" });

    expect(up.status).toBe("staged");
    expect(down.status).toBe("requested");
    expect(up.transferId).not.toBe(down.transferId);
    // Derived from the remote path when the caller does not name it.
    expect(up.name).toBe("a.tar");
    expect(down.name).toBe("x.log");
    const ttl = up.expiresAt - up.createdAt;
    expect(ttl).toBe(15 * 60 * 1000);
  });

  it("caps live transfers per user at 4 and frees a slot once one is terminal", () => {
    // Tiny files, so the concurrency cap is what bites rather than the byte
    // budget (an undeclared size reserves the whole per-file maximum).
    process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES = "1024";
    const created = Array.from({ length: 4 }, () => createTransfer(baseInput));
    expect(() => createTransfer(baseInput)).toThrowError(/too many concurrent/);
    try {
      createTransfer(baseInput);
    } catch (error) {
      expect((error as { code?: string }).code).toBe("TRANSFER_LIMIT");
    }

    // Another user is unaffected by the first user's budget.
    expect(() => createTransfer({ ...baseInput, userId: "user-2" })).not.toThrow();

    updateTransfer(created[0].transferId, { status: "failed", error: "nope" });
    expect(() => createTransfer(baseInput)).not.toThrow();
  });
});

describe("getTransfer", () => {
  it("refuses to hand a record to a different user", () => {
    const record = createTransfer(baseInput);
    expect(getTransfer(record.transferId, "user-1")).toMatchObject({ remotePath: "/srv/app/a.tar" });
    expect(getTransfer(record.transferId, "user-2")).toBeNull();
    expect(getTransfer("does-not-exist", "user-1")).toBeNull();
  });
});

describe("writeTransferContent", () => {
  it("streams to a .part file, hashes, then renames atomically", async () => {
    const record = createTransfer(baseInput);
    const payload = Buffer.from("hello remote file transfer");

    const written = await writeTransferContent(record.transferId, Readable.from([payload]), {
      maxBytes: 1024,
    });

    expect(written.sizeBytes).toBe(payload.byteLength);
    expect(written.sha256).toBe(createHash("sha256").update(payload).digest("hex"));

    const entries = await fs.readdir(stagingDir());
    expect(entries).toEqual([`${record.transferId}.bin`]);
    expect(nodeFs.readFileSync(path.join(stagingDir(), `${record.transferId}.bin`))).toEqual(payload);
  });

  it("rejects past maxBytes with a coded error and leaves no partial file", async () => {
    const record = createTransfer(baseInput);
    const chunks = [Buffer.alloc(8, 1), Buffer.alloc(8, 2)];

    await expect(
      writeTransferContent(record.transferId, Readable.from(chunks), { maxBytes: 10 }),
    ).rejects.toMatchObject({ code: "TRANSFER_TOO_LARGE" });

    const entries = await fs.readdir(stagingDir());
    expect(entries).toEqual([]);
  });

  it("lets a retry overwrite an abandoned part file", async () => {
    const record = createTransfer(baseInput);
    await fs.mkdir(stagingDir(), { recursive: true });
    await fs.writeFile(path.join(stagingDir(), `${record.transferId}.part`), "stale");

    const written = await writeTransferContent(
      record.transferId,
      Readable.from([Buffer.from("fresh")]),
      { maxBytes: 1024 },
    );

    expect(written.sizeBytes).toBe(5);
    expect(await fs.readdir(stagingDir())).toEqual([`${record.transferId}.bin`]);
  });
});

describe("openTransferContent", () => {
  it("returns the staged bytes and their size, or null when absent", async () => {
    const record = createTransfer(baseInput);
    expect(await openTransferContent(record.transferId)).toBeNull();

    await writeTransferContent(record.transferId, Readable.from([Buffer.from("abcd")]), {
      maxBytes: 1024,
    });
    const opened = await openTransferContent(record.transferId);
    if (!opened || "unsatisfiable" in opened) throw new Error("expected staged content");
    expect(opened.sizeBytes).toBe(4);
    expect(opened.totalBytes).toBe(4);
    expect(opened.partial).toBe(false);
    opened.stream.destroy();

    // Anything that could escape the staging root is refused outright.
    expect(await openTransferContent("../../etc/passwd")).toBeNull();
  });
});

describe("deleteTransfer", () => {
  it("drops the record and both on-disk files", async () => {
    const record = createTransfer(baseInput);
    await writeTransferContent(record.transferId, Readable.from([Buffer.from("abcd")]), {
      maxBytes: 1024,
    });

    await deleteTransfer(record.transferId);

    expect(getTransfer(record.transferId, "user-1")).toBeNull();
    expect(await fs.readdir(stagingDir())).toEqual([]);
  });
});

describe("janitor sweeps", () => {
  it("restarts the expiry clock on every state change", async () => {
    // A 512 MB upload on a slow link can outlive a fixed `createdAt + TTL`
    // deadline. The sweep would then drop the record and unlink the blob
    // mid-flight, and the daemon reads the resulting 404 as permanent.
    const record = createTransfer({
      userId: "user-1",
      agentHost: "ubuntu",
      direction: "up",
      remotePath: "/srv/big.tar",
    });
    const firstDeadline = record.expiresAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    updateTransfer(record.transferId, { status: "uploaded" });
    expect(record.expiresAt).toBeGreaterThan(firstDeadline);

    // ...and the record that was about to expire survives the sweep.
    expect(await pruneExpiredTransfers(firstDeadline + 1)).toBe(0);
  });

  it("prunes expired records together with their bytes", async () => {
    const record = createTransfer(baseInput);
    await writeTransferContent(record.transferId, Readable.from([Buffer.from("abcd")]), {
      maxBytes: 1024,
    });

    expect(await pruneExpiredTransfers(record.expiresAt - 1)).toBe(0);
    expect(await pruneExpiredTransfers(record.expiresAt + 1)).toBe(1);
    expect(getTransfer(record.transferId, "user-1")).toBeNull();
    expect(await fs.readdir(stagingDir())).toEqual([]);
  });

  it("reclaims unreferenced files older than an hour but spares fresh ones", async () => {
    await fs.mkdir(stagingDir(), { recursive: true });
    const orphan = path.join(stagingDir(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.bin");
    const fresh = path.join(stagingDir(), "11111111-2222-3333-4444-555555555555.part");
    await fs.writeFile(orphan, "old");
    await fs.writeFile(fresh, "new");

    // Nothing is old enough yet.
    expect(await pruneOrphanedTransferFiles(Date.now())).toBe(0);

    // Look at the directory from two hours in the future: both are now stale.
    expect(await pruneOrphanedTransferFiles(Date.now() + 2 * 60 * 60 * 1000)).toBe(2);
    expect(await fs.readdir(stagingDir())).toEqual([]);
  });

  it("never reclaims a file a live record still claims", async () => {
    const record = createTransfer(baseInput);
    await writeTransferContent(record.transferId, Readable.from([Buffer.from("abcd")]), {
      maxBytes: 1024,
    });

    expect(await pruneOrphanedTransferFiles(Date.now() + 2 * 60 * 60 * 1000)).toBe(0);
    expect(await fs.readdir(stagingDir())).toEqual([`${record.transferId}.bin`]);
  });

  it("is a no-op when the staging directory has never been created", async () => {
    expect(await pruneOrphanedTransferFiles()).toBe(0);
  });
});

describe("byte budgets", () => {
  it("defaults to 1 GiB per file, 8 GiB globally, 2 GiB per user", () => {
    for (const key of BUDGET_ENV) delete process.env[key];
    expect(remoteFileMaxBytes()).toBe(1024 * 1024 * 1024);
    expect(remoteFileTotalBytes()).toBe(8 * 1024 * 1024 * 1024);
    expect(remoteFileUserBytes()).toBe(2 * 1024 * 1024 * 1024);
  });

  it("honours the env overrides and ignores junk", () => {
    process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES = "1024";
    process.env.CONDUCTOR_REMOTE_FILE_TOTAL_BYTES = "4096";
    process.env.CONDUCTOR_REMOTE_FILE_USER_BYTES = "2048";
    expect(remoteFileMaxBytes()).toBe(1024);
    expect(remoteFileTotalBytes()).toBe(4096);
    expect(remoteFileUserBytes()).toBe(2048);

    process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES = "not-a-number";
    expect(remoteFileMaxBytes()).toBe(1024 * 1024 * 1024);
  });
});

describe("chunked uploads", () => {
  const chunk = (
    transferId: string,
    body: Buffer,
    start: number,
    total: number,
    maxBytes = 4096,
  ) => writeTransferContent(transferId, Readable.from([body]), { maxBytes, start, total });

  it("assembles three chunks and hashes every persisted byte", async () => {
    const record = createTransfer(baseInput);
    const payload = Buffer.concat([
      Buffer.alloc(10, 0x61),
      Buffer.alloc(10, 0x62),
      Buffer.alloc(10, 0x63),
    ]);

    const first = await chunk(record.transferId, payload.subarray(0, 10), 0, 30);
    expect(first).toMatchObject({ receivedBytes: 10, complete: false, sha256: null, sizeBytes: null });
    // Nothing is readable until the whole file is here.
    expect(await fs.readdir(stagingDir())).toEqual([`${record.transferId}.part`]);
    expect(getTransfer(record.transferId, "user-1")?.receivedBytes).toBe(10);

    const second = await chunk(record.transferId, payload.subarray(10, 20), 10, 30);
    expect(second).toMatchObject({ receivedBytes: 20, complete: false });

    const third = await chunk(record.transferId, payload.subarray(20), 20, 30);
    expect(third).toEqual({
      receivedBytes: 30,
      complete: true,
      sizeBytes: 30,
      // The digest covers the assembled file, not just the final chunk.
      sha256: createHash("sha256").update(payload).digest("hex"),
    });

    expect(await fs.readdir(stagingDir())).toEqual([`${record.transferId}.bin`]);
    expect(nodeFs.readFileSync(path.join(stagingDir(), `${record.transferId}.bin`))).toEqual(payload);
  });

  it("refuses a chunk at the wrong offset and reports the true cursor", async () => {
    const record = createTransfer(baseInput);
    const payload = Buffer.alloc(30, 0x7a);
    await chunk(record.transferId, payload.subarray(0, 10), 0, 30);

    await expect(chunk(record.transferId, payload.subarray(20), 20, 30)).rejects.toMatchObject({
      code: "TRANSFER_OFFSET_MISMATCH",
      receivedBytes: 10,
    });
    // The rejected chunk must not have moved the cursor or the bytes.
    expect(getTransfer(record.transferId, "user-1")?.receivedBytes).toBe(10);
    expect((await fs.stat(partFile(record.transferId))).size).toBe(10);

    // Resuming from the reported offset works.
    await chunk(record.transferId, payload.subarray(10, 20), 10, 30);
    const done = await chunk(record.transferId, payload.subarray(20), 20, 30);
    expect(done.complete).toBe(true);
    expect(done.sha256).toBe(createHash("sha256").update(payload).digest("hex"));
  });

  it("rolls a half-written chunk back to the last good offset", async () => {
    const record = createTransfer(baseInput);
    const payload = Buffer.alloc(30, 0x2b);
    await chunk(record.transferId, payload.subarray(0, 10), 0, 30);

    async function* dies() {
      yield payload.subarray(10, 14);
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("connection reset");
    }
    await expect(
      writeTransferContent(record.transferId, Readable.from(dies()), {
        maxBytes: 4096,
        start: 10,
        total: 30,
      }),
    ).rejects.toThrow(/connection reset/);

    // Neither the ledger nor the blob may keep the partial chunk, or the resume
    // would splice the retry on top of bytes nobody acknowledged.
    expect(getTransfer(record.transferId, "user-1")?.receivedBytes).toBe(10);
    expect((await fs.stat(partFile(record.transferId))).size).toBe(10);

    await chunk(record.transferId, payload.subarray(10, 20), 10, 30);
    const done = await chunk(record.transferId, payload.subarray(20), 20, 30);
    expect(done.sha256).toBe(createHash("sha256").update(payload).digest("hex"));
    expect(nodeFs.readFileSync(path.join(stagingDir(), `${record.transferId}.bin`))).toEqual(payload);
  });

  it("rejects a total that contradicts the declared size, and a chunk past it", async () => {
    const record = createTransfer({ ...baseInput, sizeBytes: 30 });

    await expect(chunk(record.transferId, Buffer.alloc(10), 0, 40)).rejects.toMatchObject({
      code: "TRANSFER_TOTAL_MISMATCH",
    });

    await chunk(record.transferId, Buffer.alloc(10), 0, 30);
    // A second chunk that would overshoot the agreed total is refused before
    // anything reaches the blob.
    await expect(chunk(record.transferId, Buffer.alloc(25), 10, 30)).rejects.toMatchObject({
      code: "TRANSFER_RANGE_INVALID",
    });
    expect(getTransfer(record.transferId, "user-1")?.receivedBytes).toBe(10);
    expect((await fs.stat(partFile(record.transferId))).size).toBe(10);
  });

  it("rejects a declared total over the per-file maximum before writing", async () => {
    const record = createTransfer(baseInput);
    await expect(chunk(record.transferId, Buffer.alloc(4), 0, 5000, 4096)).rejects.toMatchObject({
      code: "TRANSFER_TOO_LARGE",
    });
    expect(await fs.readdir(stagingDir()).catch(() => [])).toEqual([]);
  });

  it("refuses a second chunk while one is still being written", async () => {
    const record = createTransfer(baseInput);
    const payload = Buffer.alloc(20, 0x3c);

    async function* slow() {
      yield payload.subarray(0, 10);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const inFlight = writeTransferContent(record.transferId, Readable.from(slow()), {
      maxBytes: 4096,
      start: 0,
      total: 20,
    });
    // Both would read offset 0, both would pass the resume check, and the
    // second would overwrite the first.
    await expect(chunk(record.transferId, payload.subarray(0, 10), 0, 20)).rejects.toMatchObject({
      code: "TRANSFER_OFFSET_MISMATCH",
    });
    expect(await inFlight).toMatchObject({ receivedBytes: 10, complete: false });

    const done = await chunk(record.transferId, payload.subarray(10), 10, 20);
    expect(done.sha256).toBe(createHash("sha256").update(payload).digest("hex"));
  });

  it("treats a late duplicate of the final chunk as a mismatch, not a restart", async () => {
    const record = createTransfer(baseInput);
    const payload = Buffer.alloc(20, 0x5f);
    await chunk(record.transferId, payload.subarray(0, 10), 0, 20);
    await chunk(record.transferId, payload.subarray(10), 10, 20);

    await expect(chunk(record.transferId, payload.subarray(10), 10, 20)).rejects.toMatchObject({
      code: "TRANSFER_OFFSET_MISMATCH",
      receivedBytes: 20,
    });
    expect(nodeFs.readFileSync(path.join(stagingDir(), `${record.transferId}.bin`))).toEqual(payload);
  });
});

describe("ranged reads", () => {
  const payload = Buffer.from("0123456789");

  async function staged() {
    const record = createTransfer({ ...baseInput, direction: "down" });
    await writeTransferContent(record.transferId, Readable.from([payload]), { maxBytes: 1024 });
    return record;
  }

  it("serves a suffix range and reports the whole size", async () => {
    const record = await staged();
    const opened = await openTransferContent(record.transferId, { start: 4, end: null });
    if (!opened || "unsatisfiable" in opened) throw new Error("expected a partial body");

    expect(opened).toMatchObject({ sizeBytes: 6, totalBytes: 10, start: 4, end: 9, partial: true });
    const chunks: Buffer[] = [];
    for await (const piece of opened.stream) chunks.push(piece as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("456789");
  });

  it("clamps an over-long end and refuses a start past the blob", async () => {
    const record = await staged();
    const clamped = await openTransferContent(record.transferId, { start: 8, end: 99 });
    if (!clamped || "unsatisfiable" in clamped) throw new Error("expected a partial body");
    expect(clamped).toMatchObject({ start: 8, end: 9, sizeBytes: 2 });
    clamped.stream.destroy();

    expect(await openTransferContent(record.transferId, { start: 10 })).toEqual({
      unsatisfiable: true,
      totalBytes: 10,
    });
  });
});

describe("Content-Range and Range parsing", () => {
  it("accepts the one form the protocol defines", () => {
    expect(parseContentRange("bytes 0-31/64")).toEqual({ start: 0, end: 31, total: 64 });
    expect(parseContentRange("  bytes 32-63/64 ")).toEqual({ start: 32, end: 63, total: 64 });
  });

  it("rejects the forms that cannot tell us when the upload is done", () => {
    for (const header of [
      null,
      "",
      "bytes 0-31/*",
      "bytes */64",
      "bytes 32-31/64",
      "bytes 0-64/64",
      "items 0-1/2",
      "bytes 0-31",
    ]) {
      expect(parseContentRange(header), `${header}`).toBeNull();
    }
  });

  it("parses open and closed byte ranges only", () => {
    expect(parseRangeHeader("bytes=100-")).toEqual({ start: 100, end: null });
    expect(parseRangeHeader("bytes=0-99")).toEqual({ start: 0, end: 99 });
    // Suffix and multi-range are unsupported: null means "serve the whole body".
    expect(parseRangeHeader("bytes=-500")).toBeNull();
    expect(parseRangeHeader("bytes=0-9,20-29")).toBeNull();
    expect(parseRangeHeader(null)).toBeNull();
  });
});

describe("staging budgets", () => {
  beforeEach(() => {
    process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES = "400";
    process.env.CONDUCTOR_REMOTE_FILE_TOTAL_BYTES = "1000";
    process.env.CONDUCTOR_REMOTE_FILE_USER_BYTES = "1000";
  });

  const sized = (userId: string, sizeBytes: number) =>
    createTransfer({ ...baseInput, userId, sizeBytes });

  it("reserves the declared size at create time so concurrent creates cannot over-commit", () => {
    // Nothing has been written yet: a budget that counted bytes on disk would
    // wave all three of these through and only then blow past 1000.
    sized("user-1", 400);
    sized("user-2", 400);
    expect(() => sized("user-3", 400)).toThrowError(/staging is full/);
    try {
      sized("user-3", 400);
    } catch (error) {
      expect((error as { code?: string }).code).toBe("TRANSFER_BUDGET");
    }
    // The rejection is about size, not count: a smaller file still fits.
    expect(() => sized("user-3", 150)).not.toThrow();
  });

  it("keeps one user from eating the global budget", () => {
    process.env.CONDUCTOR_REMOTE_FILE_TOTAL_BYTES = "100000";
    process.env.CONDUCTOR_REMOTE_FILE_USER_BYTES = "1000";

    sized("user-1", 400);
    sized("user-1", 400);
    expect(() => sized("user-1", 400)).toThrowError(/budget exhausted for this account/);
    // ...while the rest of the box is untouched.
    expect(() => sized("user-2", 400)).not.toThrow();
  });

  it("charges an unknown download the per-file maximum", () => {
    const down = createTransfer({ ...baseInput, direction: "down" });
    expect(down.reservedBytes).toBe(400);
    createTransfer({ ...baseInput, direction: "down", userId: "user-2" });
    expect(() => createTransfer({ ...baseInput, direction: "down", userId: "user-3" })).toThrowError(
      /staging is full/,
    );
  });

  it("hands the reservation back when a transfer completes or is deleted", async () => {
    process.env.CONDUCTOR_REMOTE_FILE_TOTAL_BYTES = "100000";
    const first = sized("user-1", 400);
    const second = sized("user-1", 400);
    expect(() => sized("user-1", 400)).toThrowError(/budget exhausted/);

    // `ready` is the end of a transfer's life; its bytes are the janitor's
    // problem from here, not the budget's.
    updateTransfer(first.transferId, { status: "ready" });
    const third = sized("user-1", 400);
    expect(() => sized("user-1", 400)).toThrowError(/budget exhausted/);

    await deleteTransfer(second.transferId);
    expect(() => sized("user-1", 200)).not.toThrow();
    expect(third.reservedBytes).toBe(400);
  });

  it("shrinks a download's reservation once the real total arrives", async () => {
    const down = createTransfer({ ...baseInput, direction: "down" });
    createTransfer({ ...baseInput, direction: "down", userId: "user-2" });
    // 400 + 400 of 1000 reserved; a third worst-case download does not fit.
    expect(() => createTransfer({ ...baseInput, direction: "down", userId: "user-3" })).toThrow();

    await writeTransferContent(down.transferId, Readable.from([Buffer.alloc(10)]), {
      maxBytes: 400,
      start: 0,
      total: 10,
    });
    expect(down.reservedBytes).toBe(10);
    expect(() =>
      createTransfer({ ...baseInput, direction: "down", userId: "user-3" }),
    ).not.toThrow();
  });

  it("refuses to stage when the volume would drop below its free-space floor", () => {
    if (typeof nodeFs.statfsSync !== "function") return;
    // Budgets far above any real disk, so the free-space guard is the only
    // thing that can reject this.
    process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES = "900000000000000";
    process.env.CONDUCTOR_REMOTE_FILE_TOTAL_BYTES = "5000000000000000";
    process.env.CONDUCTOR_REMOTE_FILE_USER_BYTES = "5000000000000000";

    expect(() => createTransfer({ ...baseInput, direction: "down" })).toThrowError(
      /insufficient disk space/,
    );
  });
});

it("keeps counting a ready download's bytes until its blob is gone", async () => {
  // For a download `ready` means "fetchable": the blob sits there until the
  // client GETs it or the TTL sweep runs. A budget that ignored it would bound
  // concurrency but not storage.
  const record = createTransfer({
    userId: "user-1",
    agentHost: "ubuntu",
    direction: "down",
    remotePath: "/srv/a.bin",
    sizeBytes: 8,
  });
  await writeTransferContent(record.transferId, Readable.from([Buffer.alloc(8, 1)]), { maxBytes: 1024 });
  updateTransfer(record.transferId, { status: "ready" });

  // Still charged...
  expect(remoteFileReservedBytesForTests("user-1")).toBe(8);
  // ...and released only once the bytes actually go.
  await deleteTransfer(record.transferId);
  expect(remoteFileReservedBytesForTests("user-1")).toBe(0);
});

it("releases a delivered upload's budget and blob without waiting for the sweep", async () => {
  // Regression: a delivered upload's blob has no reader left — the daemon has
  // already written the bytes to `remotePath`. Holding the charge until the
  // TTL sweep meant two 1 GiB copies exhausted a 2 GiB budget and locked the
  // account out of `remote cp` at any size for the rest of the window.
  const record = createTransfer({
    userId: "user-1",
    agentHost: "ubuntu",
    direction: "up",
    remotePath: "/srv/a.bin",
    sizeBytes: 8,
  });
  await writeTransferContent(record.transferId, Readable.from([Buffer.alloc(8, 1)]), { maxBytes: 1024 });
  expect(remoteFileReservedBytesForTests("user-1")).toBe(8);

  updateTransfer(record.transferId, { status: "ready" });

  expect(remoteFileReservedBytesForTests("user-1")).toBe(0);
  expect(getTransfer(record.transferId, "user-1")?.status).toBe("ready");
  expect(getTransfer(record.transferId, "user-1")?.blobReleased).toBe(true);
  await vi.waitFor(() => {
    expect(nodeFs.existsSync(path.join(stagingDir(), `${record.transferId}.bin`))).toBe(false);
    expect(nodeFs.existsSync(partFile(record.transferId))).toBe(false);
  });
});

it("lets a user run back-to-back uploads that each fill the whole budget", async () => {
  process.env.CONDUCTOR_REMOTE_FILE_USER_BYTES = "16";
  // Three sequential transfers, each sized at the full per-user budget. With
  // the charge released on delivery this is fine; while it leaked, the second
  // create was refused outright.
  for (let i = 0; i < 3; i += 1) {
    const record = createTransfer({
      userId: "user-1",
      agentHost: "ubuntu",
      direction: "up",
      remotePath: `/srv/a-${i}.bin`,
      sizeBytes: 16,
    });
    await writeTransferContent(record.transferId, Readable.from([Buffer.alloc(16, 1)]), { maxBytes: 1024 });
    updateTransfer(record.transferId, { status: "ready" });
    expect(remoteFileReservedBytesForTests("user-1")).toBe(0);
  }
});
