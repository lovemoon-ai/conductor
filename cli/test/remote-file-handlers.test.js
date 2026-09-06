import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

import {
  REMOTE_FILE_CAPABILITY,
  createRemoteFileHandlers,
  handleRemoteFileRequest,
  normalizeRemotePath,
  normalizeSha256,
  remotePartPath,
  resolveRemoteChunkBytes,
  resolveRemoteFileMaxBytes,
} from "../src/remote-file-handlers.js";

const NUL = String.fromCharCode(0);
const CONFIG = { backendUrl: "https://backend.example", agentToken: "agent-token" };

function makeFakeClient() {
  const sent = [];
  return {
    sent,
    sendJson(payload) {
      sent.push(payload);
      return Promise.resolve();
    },
  };
}

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "conductor-remote-file-"));
}

function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** A fetch stand-in that serves one fixed body for GET and records PUTs. */
function makeFetch({ body = Buffer.alloc(0), status = 200, contentLength } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === "PUT") {
      // Drain the streamed body so the assertion can see the real bytes.
      const chunks = [];
      if (init.body) {
        for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
      }
      calls[calls.length - 1].uploaded = Buffer.concat(chunks);
      return { ok: status >= 200 && status < 300, status, headers: new Headers() };
    }
    const headers = new Headers();
    const declared = contentLength === undefined ? String(body.length) : contentLength;
    if (declared !== null) headers.set("content-length", declared);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers,
      body: status >= 200 && status < 300 ? new Blob([body]).stream() : null,
    };
  };
  return { fetchImpl, calls };
}

function makeHandlers(overrides = {}) {
  return createRemoteFileHandlers({
    config: CONFIG,
    agentHost: "test-host",
    fetchImpl: overrides.fetchImpl || makeFetch().fetchImpl,
    // Backoff is injected everywhere so the retry paths are instant and the
    // delays themselves are assertable instead of merely waited out.
    sleep: async () => {},
    ...overrides,
  });
}

/** Read a streamed request body the way the backend would. */
async function drain(body) {
  const chunks = [];
  if (body) {
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => payload,
  };
}

function bytesResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    body: body === null ? null : new Blob([body]).stream(),
  };
}

function parseContentRange(raw) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(raw ?? ""));
  return match
    ? { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) }
    : null;
}

/**
 * A stand-in for the backend's chunked staging area: it accepts a ranged PUT
 * only at the offset it actually holds, and answers 409 with the truth
 * otherwise. `preloaded` seeds bytes it already has, which is how a client that
 * starts from a stale offset is exercised.
 */
function makeStagingServer({ preloaded = Buffer.alloc(0), capacity = 1 << 20 } = {}) {
  const staged = Buffer.alloc(capacity);
  preloaded.copy(staged, 0);
  let received = preloaded.length;
  const calls = [];

  const fetchImpl = async (url, init = {}) => {
    const range = parseContentRange(init.headers?.["Content-Range"]);
    const uploaded = await drain(init.body);
    calls.push({
      url: String(url),
      contentRange: init.headers?.["Content-Range"],
      contentLength: init.headers?.["Content-Length"],
      bytes: uploaded.length,
    });
    const start = range ? range.start : 0;
    if (start !== received) {
      return jsonResponse(409, { error: "wrong offset", receivedBytes: received });
    }
    uploaded.copy(staged, start);
    received = start + uploaded.length;
    const total = range ? range.total : uploaded.length;
    const complete = received >= total;
    return jsonResponse(200, {
      transferId: "staged",
      status: complete ? "uploaded" : "uploading",
      receivedBytes: received,
      complete,
      ...(complete
        ? { sizeBytes: received, sha256: sha256Of(staged.subarray(0, received)) }
        : {}),
    });
  };

  return {
    fetchImpl,
    calls,
    ranges: () => calls.map((call) => call.contentRange),
    staged: () => staged.subarray(0, received),
  };
}

function patternBytes(length) {
  const buffer = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) buffer[i] = (i * 7 + 11) % 251;
  return buffer;
}

test("push streams a real file and reports its size, mode and sha256", async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "payload.bin");
  const contents = Buffer.from("hello remote file\n".repeat(100), "utf8");
  await fs.writeFile(source, contents);
  await fs.chmod(source, 0o640);
  const { fetchImpl, calls } = makeFetch();
  const handlers = makeHandlers({ fetchImpl });

  const response = await handlers.dispatch({
    action: "push",
    args: { transferId: "tr-1", transferToken: "tok-1", remotePath: source },
  });

  assert.equal(response.error, undefined);
  assert.deepEqual(response.result, {
    transferId: "tr-1",
    sizeBytes: contents.length,
    sha256: sha256Of(contents),
    mode: 0o640,
    name: "payload.bin",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://backend.example/api/agent/files/tr-1/content");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.duplex, "half");
  assert.equal(calls[0].init.headers.Authorization, "Bearer agent-token");
  assert.equal(calls[0].init.headers["X-Conductor-Host"], "test-host");
  assert.equal(calls[0].init.headers["X-Conductor-Transfer-Token"], "tok-1");
  assert.equal(calls[0].init.headers["Content-Type"], "application/octet-stream");
  assert.equal(calls[0].init.headers["Content-Length"], String(contents.length));
  assert.deepEqual(calls[0].uploaded, contents);
});

test("push surfaces a non-2xx upload as an error instead of reporting success", async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "a.txt");
  await fs.writeFile(source, "x");
  const { fetchImpl } = makeFetch({ status: 410 });
  const handlers = makeHandlers({ fetchImpl });

  const response = await handlers.dispatch({
    action: "push",
    args: { transferId: "tr-1", transferToken: "tok-1", remotePath: source },
  });

  assert.match(response.error, /upload failed with HTTP 410 \(permanent\)/);
});

test("push splits a file larger than one chunk into consecutive ranged PUTs", async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "big.bin");
  const contents = patternBytes(2500);
  await fs.writeFile(source, contents);
  const server = makeStagingServer();
  const handlers = makeHandlers({ fetchImpl: server.fetchImpl, chunkBytes: 1000 });

  const response = await handlers.dispatch({
    action: "push",
    args: { transferId: "tr-chunk", transferToken: "tok-chunk", remotePath: source },
  });

  assert.equal(response.error, undefined);
  assert.equal(response.result.sizeBytes, 2500);
  assert.equal(response.result.sha256, sha256Of(contents));
  assert.deepEqual(server.ranges(), [
    "bytes 0-999/2500",
    "bytes 1000-1999/2500",
    "bytes 2000-2499/2500",
  ]);
  assert.deepEqual(
    server.calls.map((call) => call.contentLength),
    ["1000", "1000", "500"],
  );
  // The point of chunking: the pieces have to reassemble to the original file.
  assert.deepEqual(server.staged(), contents);
});

test("push follows the receivedBytes a 409 reports instead of failing", async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "resync.bin");
  const contents = patternBytes(2500);
  await fs.writeFile(source, contents);
  // The server already holds the first 1500 bytes; our optimistic start at 0
  // is wrong and it says so.
  const server = makeStagingServer({ preloaded: contents.subarray(0, 1500) });
  const handlers = makeHandlers({ fetchImpl: server.fetchImpl, chunkBytes: 1000 });

  const response = await handlers.dispatch({
    action: "push",
    args: { transferId: "tr-409", transferToken: "tok-409", remotePath: source },
  });

  assert.equal(response.error, undefined);
  assert.equal(response.result.sha256, sha256Of(contents));
  assert.deepEqual(server.ranges(), ["bytes 0-999/2500", "bytes 1500-2499/2500"]);
  assert.deepEqual(server.staged(), contents);
});

test("push retries a dropped connection without re-sending accepted bytes", async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "flaky.bin");
  const contents = patternBytes(2500);
  await fs.writeFile(source, contents);
  const server = makeStagingServer();
  const attempted = [];
  const sleeps = [];
  let dropped = false;
  const fetchImpl = async (url, init = {}) => {
    attempted.push(init.headers?.["Content-Range"]);
    if (!dropped && init.headers?.["Content-Range"] === "bytes 1000-1999/2500") {
      dropped = true;
      // A real transport reads the body and then loses the socket.
      await drain(init.body);
      throw Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNRESET") });
    }
    return server.fetchImpl(url, init);
  };
  const handlers = makeHandlers({
    fetchImpl,
    chunkBytes: 1000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const response = await handlers.dispatch({
    action: "push",
    args: { transferId: "tr-drop", transferToken: "tok-drop", remotePath: source },
  });

  assert.equal(response.error, undefined);
  assert.deepEqual(attempted, [
    "bytes 0-999/2500",
    "bytes 1000-1999/2500",
    "bytes 1000-1999/2500",
    "bytes 2000-2499/2500",
  ]);
  assert.deepEqual(sleeps, [500], "one blip costs one backoff, not a restart");
  assert.equal(
    server.ranges().filter((range) => range === "bytes 0-999/2500").length,
    1,
    "an accepted chunk is never sent twice",
  );
  assert.deepEqual(server.staged(), contents);
});

test("push gives up immediately on 413 instead of retrying a permanent refusal", async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "toobig.bin");
  await fs.writeFile(source, patternBytes(2500));
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (_url, init = {}) => {
    calls.push(init.headers?.["Content-Range"]);
    await drain(init.body);
    return jsonResponse(413, { error: "file too large" });
  };
  const handlers = makeHandlers({
    fetchImpl,
    chunkBytes: 1000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const response = await handlers.dispatch({
    action: "push",
    args: { transferId: "tr-413", transferToken: "tok-413", remotePath: source },
  });

  assert.match(response.error, /upload failed with HTTP 413 \(permanent\)/);
  assert.equal(calls.length, 1, "413 is the server's final answer");
  assert.deepEqual(sleeps, []);
});

test("push stops after four attempts against an endpoint that always fails", async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "doomed.bin");
  await fs.writeFile(source, patternBytes(2500));
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (_url, init = {}) => {
    calls.push(init.headers?.["Content-Range"]);
    await drain(init.body);
    return jsonResponse(500, { error: "boom" });
  };
  const handlers = makeHandlers({
    fetchImpl,
    chunkBytes: 1000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const response = await handlers.dispatch({
    action: "push",
    args: { transferId: "tr-500", transferToken: "tok-500", remotePath: source },
  });

  assert.match(response.error, /upload failed with HTTP 500/);
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [500, 1000, 2000], "500 ms doubling, then stop");
});

test("push refuses a 409 that points at the offset it just rejected", async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "stuck.bin");
  await fs.writeFile(source, patternBytes(100));
  const calls = [];
  const fetchImpl = async (_url, init = {}) => {
    calls.push(init.headers?.["Content-Range"]);
    await drain(init.body);
    // A server that keeps saying "you are at 0" while refusing 0 would loop
    // forever if the daemon believed it.
    return jsonResponse(409, { error: "wrong offset", receivedBytes: 0 });
  };
  const handlers = makeHandlers({ fetchImpl, chunkBytes: 1000 });

  const response = await handlers.dispatch({
    action: "push",
    args: { transferId: "tr-loop", transferToken: "tok-loop", remotePath: source },
  });

  assert.match(response.error, /upload failed with HTTP 409 \(permanent\)/);
  assert.equal(calls.length, 1);
});

test("pull downloads, verifies sha256 and lands the file atomically", async () => {
  const dir = await makeTempDir();
  const dest = path.join(dir, "landed.bin");
  const body = Buffer.from("downloaded bytes\n".repeat(50), "utf8");
  const { fetchImpl, calls } = makeFetch({ body });
  const handlers = makeHandlers({ fetchImpl });

  const response = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-2",
      transferToken: "tok-2",
      remotePath: dest,
      sha256: sha256Of(body),
      sizeBytes: body.length,
      mode: 0o600,
    },
  });

  assert.equal(response.error, undefined);
  assert.deepEqual(response.result, { transferId: "tr-2", bytesWritten: body.length, path: dest });
  assert.deepEqual(await fs.readFile(dest), body);
  assert.equal((await fs.stat(dest)).mode & 0o777, 0o600);
  assert.equal(calls[0].init.headers.Accept, "application/octet-stream");
  assert.deepEqual(await fs.readdir(dir), ["landed.bin"]);
});

test("pull rejects a sha256 mismatch and leaves no .part behind", async () => {
  const dir = await makeTempDir();
  const dest = path.join(dir, "corrupt.bin");
  const body = Buffer.from("actual bytes", "utf8");
  const { fetchImpl } = makeFetch({ body });
  const handlers = makeHandlers({ fetchImpl });

  const response = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-3",
      transferToken: "tok-3",
      remotePath: dest,
      sha256: sha256Of(Buffer.from("different bytes", "utf8")),
      sizeBytes: body.length,
    },
  });

  assert.match(response.error, /SHA-256 mismatch/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("pull rejects a body longer than the declared size mid-stream", async () => {
  const dir = await makeTempDir();
  const dest = path.join(dir, "overrun.bin");
  const body = Buffer.alloc(4096, 0x41);
  // The server lies in both the header and the stream; the declared size wins.
  const { fetchImpl } = makeFetch({ body, contentLength: "8" });
  const handlers = makeHandlers({ fetchImpl });

  const response = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-4",
      transferToken: "tok-4",
      remotePath: dest,
      sha256: sha256Of(body),
      sizeBytes: 8,
    },
  });

  assert.match(response.error, /exceeded the declared size|Content-Length mismatch/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("pull refuses a Content-Length that disagrees with the declared size", async () => {
  const dir = await makeTempDir();
  const dest = path.join(dir, "mismatch.bin");
  const body = Buffer.from("abc", "utf8");
  const { fetchImpl } = makeFetch({ body, contentLength: "99" });
  const handlers = makeHandlers({ fetchImpl });

  const response = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-5",
      transferToken: "tok-5",
      remotePath: dest,
      sha256: sha256Of(body),
      sizeBytes: body.length,
    },
  });

  assert.match(response.error, /Content-Length mismatch/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("pull into an existing directory appends the file name (scp semantics)", async () => {
  const dir = await makeTempDir();
  const body = Buffer.from("into a dir", "utf8");
  const { fetchImpl } = makeFetch({ body });
  const handlers = makeHandlers({ fetchImpl });

  const response = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-6",
      transferToken: "tok-6",
      remotePath: dir,
      name: "from-args.txt",
      sha256: sha256Of(body),
      sizeBytes: body.length,
    },
  });

  assert.equal(response.error, undefined);
  assert.equal(response.result.path, path.join(dir, "from-args.txt"));
  assert.deepEqual(await fs.readFile(path.join(dir, "from-args.txt")), body);
});

test("pull skips the download when the destination already has the same size and hash", async () => {
  const dir = await makeTempDir();
  const dest = path.join(dir, "same.bin");
  const body = Buffer.from("identical content", "utf8");
  await fs.writeFile(dest, body);
  const { fetchImpl, calls } = makeFetch({ body });
  const handlers = makeHandlers({ fetchImpl });

  const response = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-7",
      transferToken: "tok-7",
      remotePath: dest,
      sha256: sha256Of(body),
      sizeBytes: body.length,
    },
  });

  assert.equal(response.error, undefined);
  assert.deepEqual(response.result, { transferId: "tr-7", bytesWritten: body.length, path: dest });
  assert.equal(calls.length, 0, "no HTTP request may be made for an identical file");
});

test("pull never truncates the existing destination when the transfer fails", async () => {
  const dir = await makeTempDir();
  const dest = path.join(dir, "precious.txt");
  await fs.writeFile(dest, "do not lose me");
  const { fetchImpl } = makeFetch({ status: 404 });
  const handlers = makeHandlers({ fetchImpl });

  const body = Buffer.from("replacement", "utf8");
  const response = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-8",
      transferToken: "tok-8",
      remotePath: dest,
      sha256: sha256Of(body),
      sizeBytes: body.length,
    },
  });

  assert.match(response.error, /download failed with HTTP 404 \(permanent\)/);
  assert.equal(await fs.readFile(dest, "utf8"), "do not lose me");
  assert.deepEqual(await fs.readdir(dir), ["precious.txt"]);
});

test("pull resumes an interrupted download from the size of its .part", async () => {
  const dir = await makeTempDir();
  const dest = path.join(dir, "resumed.bin");
  const body = patternBytes(2000);
  const ranges = [];
  const sleeps = [];
  const fetchImpl = async (_url, init = {}) => {
    const range = init.headers?.Range;
    ranges.push(range);
    if (!range) {
      // The connection dies after 800 bytes; the declared length still names
      // the whole object.
      return bytesResponse(200, body.subarray(0, 800), { "content-length": String(body.length) });
    }
    const start = Number(/^bytes=(\d+)-$/.exec(range)[1]);
    return bytesResponse(206, body.subarray(start), {
      "content-length": String(body.length - start),
      "content-range": `bytes ${start}-${body.length - 1}/${body.length}`,
    });
  };
  const handlers = makeHandlers({
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const response = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-resume",
      transferToken: "tok-resume",
      remotePath: dest,
      sha256: sha256Of(body),
      sizeBytes: body.length,
    },
  });

  assert.equal(response.error, undefined);
  assert.deepEqual(response.result, {
    transferId: "tr-resume",
    bytesWritten: body.length,
    path: dest,
  });
  assert.deepEqual(ranges, [undefined, "bytes=800-"], "the .part's size is the offset");
  assert.deepEqual(sleeps, [500]);
  const landed = await fs.readFile(dest);
  assert.deepEqual(landed, body);
  assert.equal(sha256Of(landed), sha256Of(body), "the hash covers the assembled file");
  assert.deepEqual(await fs.readdir(dir), ["resumed.bin"]);
});

test("pull treats 416 as 'nothing left to fetch' and verifies the .part it holds", async () => {
  const dir = await makeTempDir();
  const dest = path.join(dir, "already.bin");
  const body = patternBytes(2000);
  // A previous attempt in this call left a complete partial behind.
  await fs.writeFile(remotePartPath(dest), body);
  const ranges = [];
  const fetchImpl = async (_url, init = {}) => {
    ranges.push(init.headers?.Range);
    return bytesResponse(416, null, { "content-range": `bytes */${body.length}` });
  };
  const handlers = makeHandlers({ fetchImpl });

  const response = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-416",
      transferToken: "tok-416",
      remotePath: dest,
      sha256: sha256Of(body),
      sizeBytes: body.length,
      mode: 0o600,
    },
  });

  assert.equal(response.error, undefined);
  assert.equal(response.result.bytesWritten, body.length);
  assert.deepEqual(ranges, ["bytes=2000-"]);
  assert.deepEqual(await fs.readFile(dest), body);
  assert.equal((await fs.stat(dest)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(dir), ["already.bin"]);
});

test("pull rejects a resumed assembly whose sha256 is wrong and deletes the .part", async () => {
  const dir = await makeTempDir();
  const dest = path.join(dir, "poisoned.bin");
  const body = patternBytes(2000);
  // The partial holds the right number of bytes but the wrong ones, so only a
  // hash of the finished file can catch it.
  await fs.writeFile(remotePartPath(dest), Buffer.alloc(800, 0x41));
  const fetchImpl = async (_url, init = {}) => {
    const start = Number(/^bytes=(\d+)-$/.exec(init.headers.Range)[1]);
    return bytesResponse(206, body.subarray(start), {
      "content-length": String(body.length - start),
      "content-range": `bytes ${start}-${body.length - 1}/${body.length}`,
    });
  };
  const handlers = makeHandlers({ fetchImpl });

  const response = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-bad-resume",
      transferToken: "tok-bad-resume",
      remotePath: dest,
      sha256: sha256Of(body),
      sizeBytes: body.length,
    },
  });

  assert.match(response.error, /SHA-256 mismatch/);
  assert.deepEqual(await fs.readdir(dir), [], "a failed resume leaves nothing behind");
});

test("pull discards a stale .part when the server ignores the Range", async () => {
  const dir = await makeTempDir();
  const dest = path.join(dir, "restarted.bin");
  const body = patternBytes(2000);
  await fs.writeFile(remotePartPath(dest), Buffer.alloc(800, 0x41));
  const fetchImpl = async () =>
    bytesResponse(200, body, { "content-length": String(body.length) });
  const handlers = makeHandlers({ fetchImpl });

  const response = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-ignored-range",
      transferToken: "tok-ignored-range",
      remotePath: dest,
      sha256: sha256Of(body),
      sizeBytes: body.length,
    },
  });

  assert.equal(response.error, undefined);
  assert.deepEqual(await fs.readFile(dest), body, "appending would have interleaved two copies");
  assert.deepEqual(await fs.readdir(dir), ["restarted.bin"]);
});

test("pull refuses a 206 that resumes at an offset it did not ask for", async () => {
  const dir = await makeTempDir();
  const dest = path.join(dir, "wrong-offset.bin");
  const body = patternBytes(2000);
  await fs.writeFile(remotePartPath(dest), body.subarray(0, 800));
  const calls = [];
  const fetchImpl = async (_url, init = {}) => {
    calls.push(init.headers?.Range);
    return bytesResponse(206, body.subarray(900), {
      "content-length": String(body.length - 900),
      "content-range": `bytes 900-${body.length - 1}/${body.length}`,
    });
  };
  const handlers = makeHandlers({ fetchImpl });

  const response = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-skew",
      transferToken: "tok-skew",
      remotePath: dest,
      sha256: sha256Of(body),
      sizeBytes: body.length,
    },
  });

  assert.match(response.error, /resumed at the wrong offset/);
  assert.equal(calls.length, 1, "a lying server is not worth a retry");
  assert.deepEqual(await fs.readdir(dir), []);
});

test("pull refuses a 206 that does not say where its bytes belong", async () => {
  const dir = await makeTempDir();
  const dest = path.join(dir, "no-range.bin");
  const body = patternBytes(2000);
  await fs.writeFile(remotePartPath(dest), body.subarray(0, 800));
  const fetchImpl = async () =>
    bytesResponse(206, body.subarray(800), { "content-length": String(1200) });
  const handlers = makeHandlers({ fetchImpl });

  const response = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-no-range",
      transferToken: "tok-no-range",
      remotePath: dest,
      sha256: sha256Of(body),
      sizeBytes: body.length,
    },
  });

  assert.match(response.error, /206 without a usable Content-Range/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("pull stops after four attempts against an endpoint that always fails", async () => {
  const dir = await makeTempDir();
  const dest = path.join(dir, "never.bin");
  const body = patternBytes(64);
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (_url, init = {}) => {
    calls.push(init.headers?.Range);
    return bytesResponse(503, null);
  };
  const handlers = makeHandlers({
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const response = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-doomed",
      transferToken: "tok-doomed",
      remotePath: dest,
      sha256: sha256Of(body),
      sizeBytes: body.length,
    },
  });

  assert.match(response.error, /download failed with HTTP 503/);
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [500, 1000, 2000]);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("push reports a missing path and refuses a directory", async () => {
  const dir = await makeTempDir();
  const handlers = makeHandlers();

  const missing = await handlers.dispatch({
    action: "push",
    args: { transferId: "tr-9", transferToken: "tok-9", remotePath: path.join(dir, "nope.txt") },
  });
  assert.match(missing.error, /no such file: /);

  const directory = await handlers.dispatch({
    action: "push",
    args: { transferId: "tr-9", transferToken: "tok-9", remotePath: dir },
  });
  assert.match(directory.error, /is a directory \(recursive transfer is not supported\)/);
});

test("push refuses a file over the configured size limit", async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "big.bin");
  await fs.writeFile(source, Buffer.alloc(2048));
  const handlers = makeHandlers({ maxBytes: 1024 });

  const response = await handlers.dispatch({
    action: "push",
    args: { transferId: "tr-10", transferToken: "tok-10", remotePath: source },
  });

  assert.match(response.error, /is 2048 bytes, over the 1024 byte limit/);
});

test("stat describes a file, a directory and a missing path without throwing", async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, "s.txt");
  await fs.writeFile(file, "1234");
  await fs.chmod(file, 0o644);
  const handlers = makeHandlers();

  const fileStat = await handlers.dispatch({ action: "stat", args: { remotePath: file } });
  assert.equal(fileStat.error, undefined);
  assert.equal(fileStat.result.exists, true);
  assert.equal(fileStat.result.isFile, true);
  assert.equal(fileStat.result.isDirectory, false);
  assert.equal(fileStat.result.sizeBytes, 4);
  assert.equal(fileStat.result.mode, 0o644);
  assert.ok(Date.parse(fileStat.result.mtime) > 0);

  const dirStat = await handlers.dispatch({ action: "stat", args: { remotePath: dir } });
  assert.equal(dirStat.result.isDirectory, true);
  assert.equal(dirStat.result.isFile, false);

  const missing = await handlers.dispatch({
    action: "stat",
    args: { remotePath: path.join(dir, "gone", "x.txt") },
  });
  assert.equal(missing.error, undefined);
  assert.deepEqual(missing.result, {
    path: path.join(dir, "gone", "x.txt"),
    exists: false,
    isFile: false,
    isDirectory: false,
    sizeBytes: null,
    mode: null,
    mtime: null,
  });
});

test("guestRoot confines pull, push and stat to the shared root", async () => {
  const root = await makeTempDir();
  const outside = await makeTempDir();
  const outsideFile = path.join(outside, "secret.txt");
  await fs.writeFile(outsideFile, "nope");
  const body = Buffer.from("inside", "utf8");
  const { fetchImpl, calls } = makeFetch({ body });
  const handlers = makeHandlers({ fetchImpl, guestRoot: root });

  const pushOutside = await handlers.dispatch({
    action: "push",
    args: { transferId: "tr-11", transferToken: "tok-11", remotePath: outsideFile },
  });
  assert.match(pushOutside.error, /outside this daemon's shared root/);

  const pullOutside = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-11",
      transferToken: "tok-11",
      remotePath: path.join(outside, "landed.bin"),
      sha256: sha256Of(body),
      sizeBytes: body.length,
    },
  });
  assert.match(pullOutside.error, /outside this daemon's shared root/);
  assert.equal(calls.length, 0, "a refused path must not reach the backend");

  const escape = await handlers.dispatch({
    action: "stat",
    args: { remotePath: path.join(root, "..", path.basename(outside), "secret.txt") },
  });
  assert.match(escape.error, /outside this daemon's shared root/);

  // Inside the root everything still works.
  const inside = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-12",
      transferToken: "tok-12",
      remotePath: path.join(root, "ok.bin"),
      sha256: sha256Of(body),
      sizeBytes: body.length,
    },
  });
  assert.equal(inside.error, undefined);
  assert.deepEqual(await fs.readFile(path.join(root, "ok.bin")), body);
});

test("paths with NUL bytes, non-strings and blanks are rejected for every action", async () => {
  const handlers = makeHandlers();

  const withPath = (remotePath) => ({
    transferId: "tr-13",
    transferToken: "tok-13",
    sha256: "a".repeat(64),
    sizeBytes: 1,
    remotePath,
  });

  for (const action of ["pull", "push", "stat"]) {
    const nul = await handlers.dispatch({ action, args: withPath(`/tmp/evil${NUL}.txt`) });
    assert.match(nul.error, /must not contain NUL bytes/, `${action} must reject NUL`);

    const notAString = await handlers.dispatch({ action, args: withPath(42) });
    assert.match(notAString.error, /requires a `remotePath` string/, `${action} must reject numbers`);

    const blank = await handlers.dispatch({ action, args: withPath("   ") });
    assert.match(blank.error, /requires a `remotePath` string/, `${action} must reject blanks`);
  }
});

test("pull and push validate their transfer identifiers and descriptors", async () => {
  const dir = await makeTempDir();
  const handlers = makeHandlers({ maxBytes: 1024 });

  const noId = await handlers.dispatch({
    action: "pull",
    args: { remotePath: path.join(dir, "x"), sha256: "a".repeat(64), sizeBytes: 1 },
  });
  assert.match(noId.error, /requires a `transferId` string/);

  const noToken = await handlers.dispatch({
    action: "push",
    args: { transferId: "tr-14", remotePath: path.join(dir, "x") },
  });
  assert.match(noToken.error, /requires a `transferToken` string/);

  const badHash = await handlers.dispatch({
    action: "pull",
    args: { transferId: "t", transferToken: "k", remotePath: path.join(dir, "x"), sha256: "nope", sizeBytes: 1 },
  });
  assert.match(badHash.error, /64-character hex `sha256`/);

  const badSize = await handlers.dispatch({
    action: "pull",
    args: { transferId: "t", transferToken: "k", remotePath: path.join(dir, "x"), sha256: "a".repeat(64) },
  });
  assert.match(badSize.error, /`sizeBytes` must be a non-negative integer/);

  const tooBig = await handlers.dispatch({
    action: "pull",
    args: {
      transferId: "t",
      transferToken: "k",
      remotePath: path.join(dir, "x"),
      sha256: "a".repeat(64),
      sizeBytes: 2048,
    },
  });
  assert.match(tooBig.error, /over this daemon's 1024 byte limit/, "handler-level cap applies");
});

test("a fifth simultaneous transfer is refused until a slot frees up", async () => {
  const dir = await makeTempDir();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fetchImpl = async () => {
    await gate;
    return { ok: false, status: 503, headers: new Headers(), body: null };
  };
  const handlers = makeHandlers({ fetchImpl });

  const args = (i) => ({
    transferId: `tr-${i}`,
    transferToken: `tok-${i}`,
    remotePath: path.join(dir, `f${i}.bin`),
    sha256: "b".repeat(64),
    sizeBytes: 4,
  });

  const inFlight = [];
  for (let i = 0; i < 4; i += 1) {
    inFlight.push(handlers.dispatch({ action: "pull", args: args(i) }));
  }
  // Let each pull reach its (blocked) fetch before probing the cap.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const refused = await handlers.dispatch({ action: "pull", args: args(99) });
  assert.match(refused.error, /too many concurrent remote file transfers on this daemon \(4\/4\)/);

  release();
  const settled = await Promise.all(inFlight);
  for (const response of settled) {
    assert.match(response.error, /download failed with HTTP 503/);
  }

  // Once they finish the daemon accepts work again.
  const accepted = await handlers.dispatch({ action: "pull", args: args(100) });
  assert.match(accepted.error, /download failed with HTTP 503/);
});

test("abortAll cancels an in-flight transfer instead of waiting it out", async () => {
  const dir = await makeTempDir();
  let seenSignal = null;
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      seenSignal = init.signal;
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
  const handlers = makeHandlers({ fetchImpl });

  const pending = handlers.dispatch({
    action: "pull",
    args: {
      transferId: "tr-abort",
      transferToken: "tok-abort",
      remotePath: path.join(dir, "aborted.bin"),
      sha256: "c".repeat(64),
      sizeBytes: 4,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  handlers.abortAll();

  const response = await pending;
  assert.ok(seenSignal, "the transfer must carry an AbortSignal");
  assert.match(response.error, /remote file transfers closed/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("handleRemoteFileRequest replies with remote_file_response carrying the result", async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, "reply.txt");
  await fs.writeFile(file, "hi");
  const handlers = makeHandlers();
  const client = makeFakeClient();

  await handleRemoteFileRequest(client, handlers, {
    request_id: "req-1",
    action: "stat",
    args: { remotePath: file },
  });

  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].type, "remote_file_response");
  assert.equal(client.sent[0].payload.request_id, "req-1");
  assert.equal(client.sent[0].payload.action, "stat");
  assert.equal(client.sent[0].payload.result.exists, true);
  assert.equal(client.sent[0].payload.error, undefined);
});

test("handleRemoteFileRequest reports errors and ignores payloads without a request_id", async () => {
  const handlers = makeHandlers();
  const client = makeFakeClient();

  const noRequestId = await handleRemoteFileRequest(client, handlers, { action: "stat" });
  assert.equal(noRequestId.error, "missing request_id");
  assert.equal(client.sent.length, 0);

  await handleRemoteFileRequest(client, handlers, { request_id: "req-2", action: "teleport" });
  assert.equal(client.sent[0].payload.error, "unknown action: teleport");
  assert.equal(client.sent[0].payload.result, undefined);
});

test("dispatch rejects unknown actions without throwing", async () => {
  const handlers = makeHandlers();
  assert.match((await handlers.dispatch({ action: "delete" })).error, /unknown action: delete/);
  assert.match((await handlers.dispatch({})).error, /unknown action: undefined/);
});

test("normalizeRemotePath expands ~ and resolves relative segments", () => {
  assert.equal(normalizeRemotePath("~"), path.resolve(os.homedir()));
  assert.equal(normalizeRemotePath("~/x/../y"), path.join(os.homedir(), "y"));
  assert.equal(normalizeRemotePath("/tmp/a/../b"), path.resolve("/tmp/b"));
  assert.throws(() => normalizeRemotePath(""), /requires a `remotePath` string/);
  assert.throws(() => normalizeRemotePath(`/tmp/a${NUL}`), /NUL bytes/);
});

test("normalizeSha256 only accepts a 64-character hex digest", () => {
  assert.equal(normalizeSha256(` ${"A".repeat(64)} `), "a".repeat(64));
  assert.equal(normalizeSha256("a".repeat(63)), "");
  assert.equal(normalizeSha256("z".repeat(64)), "");
  assert.equal(normalizeSha256(undefined), "");
});

test("resolveRemoteFileMaxBytes prefers the option, then the env var, then 1 GiB", () => {
  const previous = process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES;
  try {
    delete process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES;
    assert.equal(resolveRemoteFileMaxBytes(), 1024 * 1024 * 1024);
    assert.equal(resolveRemoteFileMaxBytes(4096), 4096);
    process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES = "2048";
    assert.equal(resolveRemoteFileMaxBytes(), 2048);
    assert.equal(resolveRemoteFileMaxBytes(4096), 4096);
    process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES = "garbage";
    assert.equal(resolveRemoteFileMaxBytes(), 1024 * 1024 * 1024);
  } finally {
    if (previous === undefined) delete process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES;
    else process.env.CONDUCTOR_REMOTE_FILE_MAX_BYTES = previous;
  }
});

test("resolveRemoteChunkBytes prefers the option, then the env var, then 32 MiB", () => {
  const previous = process.env.CONDUCTOR_REMOTE_CHUNK_BYTES;
  try {
    delete process.env.CONDUCTOR_REMOTE_CHUNK_BYTES;
    assert.equal(resolveRemoteChunkBytes(), 32 * 1024 * 1024);
    assert.equal(resolveRemoteChunkBytes(4096), 4096);
    process.env.CONDUCTOR_REMOTE_CHUNK_BYTES = "8192";
    assert.equal(resolveRemoteChunkBytes(), 8192);
    assert.equal(resolveRemoteChunkBytes(4096), 4096);
    process.env.CONDUCTOR_REMOTE_CHUNK_BYTES = "garbage";
    assert.equal(resolveRemoteChunkBytes(), 32 * 1024 * 1024);
  } finally {
    if (previous === undefined) delete process.env.CONDUCTOR_REMOTE_CHUNK_BYTES;
    else process.env.CONDUCTOR_REMOTE_CHUNK_BYTES = previous;
  }
});

test("remotePartPath keeps the partial next to its destination", () => {
  assert.equal(remotePartPath("/tmp/a.bin"), `/tmp/a.bin.${process.pid}.part`);
});

test("the capability constant is the negotiated name", () => {
  assert.equal(REMOTE_FILE_CAPABILITY, "remote_file");
});
