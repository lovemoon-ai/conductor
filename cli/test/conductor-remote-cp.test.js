import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { ConductorConfig } from "@love-moon/conductor-sdk";
import {
  formatBytes,
  parseCpArgs,
  parseRemoteSpec,
  parseTimeoutMs,
  runRemoteCp,
  chunkBytes,
} from "../src/remote/cp.js";

const config = new ConductorConfig({
  agentToken: "test-token",
  backendUrl: "http://localhost:6152",
});

function makeConsole() {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    log: (...args) => logs.push(args.join(" ")),
    error: (...args) => errors.push(args.join(" ")),
  };
}

function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "conductor-remote-cp-"));
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/**
 * A fake backend. `responses` entries are either `{body}` for JSON replies or
 * `{bytes}` for an octet-stream download.
 */
function makeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    fetch: async (url, init) => {
      const body = init?.body;
      // Drain a streaming upload body so the test can assert on what was sent.
      let uploaded = null;
      if (body && typeof body.getReader === "function") {
        const chunks = [];
        for await (const chunk of Readable.fromWeb(body)) chunks.push(chunk);
        uploaded = Buffer.concat(chunks);
      }
      calls.push({ url, init, uploaded });

      const next = queue.shift();
      if (!next) throw new Error(`unexpected extra fetch: ${url}`);
      const status = next.status ?? 200;
      if (next.bytes !== undefined) {
        return {
          ok: status < 400,
          status,
          body: Readable.toWeb(Readable.from([next.bytes])),
          text: async () => next.bytes.toString(),
        };
      }
      return {
        ok: status < 400,
        status,
        body: null,
        text: async () => JSON.stringify(next.body ?? {}),
      };
    },
  };
}

test("parseRemoteSpec splits daemon:path and leaves local paths alone", () => {
  assert.deepEqual(parseRemoteSpec("ubuntu:/srv/a.tar"), { target: "ubuntu", path: "/srv/a.tar" });
  assert.equal(parseRemoteSpec("./a.tar"), null);
  assert.equal(parseRemoteSpec("/srv/a.tar"), null);
  assert.equal(parseRemoteSpec("~/a.tar"), null);
  // A local file whose name contains a colon stays reachable via ./
  assert.equal(parseRemoteSpec("./weird:name"), null);
});

test("parseRemoteSpec falls back to --target for the :path form", () => {
  assert.deepEqual(parseRemoteSpec(":/tmp/a", "ubuntu"), { target: "ubuntu", path: "/tmp/a" });
  assert.throws(() => parseRemoteSpec(":/tmp/a"), /no --target given/);
});

test("parseCpArgs collects flags and two paths", () => {
  const { options, paths } = parseCpArgs(["-t", "ubuntu", "--json", "./a", "ubuntu:/b"]);
  assert.equal(options.target, "ubuntu");
  assert.equal(options.json, true);
  assert.deepEqual(paths, ["./a", "ubuntu:/b"]);
});

test("parseCpArgs rejects unknown options rather than treating them as paths", () => {
  assert.throws(() => parseCpArgs(["--verbose", "./a", "ubuntu:/b"]), /unknown option: --verbose/);
});

test("parseTimeoutMs leaves room for a 1 GiB transfer by default", () => {
  // 1 GiB on a slow uplink is tens of minutes, and with resume a long transfer
  // is safe. Cutting one off mid-flight is the worse failure.
  assert.equal(parseTimeoutMs(undefined), 1_800_000);
  assert.equal(parseTimeoutMs("30s"), 30_000);
});

test("formatBytes stays readable across units", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
});

test("runRemoteCp uploads a local file and delivers it", async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "build.tar.gz");
  const payload = Buffer.from("hello conductor");
  await fsp.writeFile(source, payload);

  const consoleImpl = makeConsole();
  const { fetch, calls } = makeFetch([
    { body: { transferId: "t-1", status: "staged" } },
    { body: { transferId: "t-1", status: "uploaded" } },
    { body: { transferId: "t-1", status: "ready", path: "/srv/app/build.tar.gz", bytesWritten: payload.length } },
  ]);

  const code = await runRemoteCp([source, "ubuntu:/srv/app/build.tar.gz"], {
    config,
    fetch,
    console: consoleImpl,
  });

  assert.equal(code, 0);
  assert.equal(calls.length, 3);

  const created = JSON.parse(calls[0].init.body);
  assert.equal(created.direction, "up");
  assert.equal(created.remotePath, "/srv/app/build.tar.gz");
  assert.equal(created.sizeBytes, payload.length);
  assert.equal(created.sha256, sha256(payload));
  assert.equal(created.name, "build.tar.gz");

  assert.match(calls[1].url, /\/api\/agents\/ubuntu\/files\/t-1\/content$/);
  assert.equal(calls[1].init.method, "PUT");
  assert.deepEqual(calls[1].uploaded, payload);

  assert.match(calls[2].url, /\/files\/t-1\/deliver$/);
  assert.ok(consoleImpl.errors.some((line) => line.includes("uploaded")));

  await fsp.rm(dir, { recursive: true, force: true });
});

test("runRemoteCp downloads to a local path and verifies the checksum", async () => {
  const dir = await makeTempDir();
  const destination = path.join(dir, "conductor.log");
  const payload = Buffer.from("line one\nline two\n");

  const consoleImpl = makeConsole();
  const { fetch } = makeFetch([
    {
      body: {
        transferId: "t-2",
        status: "ready",
        sizeBytes: payload.length,
        sha256: sha256(payload),
        name: "conductor.log",
        mode: 0o644,
      },
    },
    { bytes: payload },
  ]);

  const code = await runRemoteCp(["ubuntu:/var/log/conductor.log", destination], {
    config,
    fetch,
    console: consoleImpl,
  });

  assert.equal(code, 0);
  assert.deepEqual(await fsp.readFile(destination), payload);
  assert.equal(fs.existsSync(`${destination}.${process.pid}.part`), false);

  await fsp.rm(dir, { recursive: true, force: true });
});

test("runRemoteCp downloading onto a directory keeps the remote basename", async () => {
  const dir = await makeTempDir();
  const payload = Buffer.from("payload");

  const { fetch } = makeFetch([
    {
      body: {
        transferId: "t-3",
        status: "ready",
        sizeBytes: payload.length,
        sha256: sha256(payload),
        name: "app.log",
      },
    },
    { bytes: payload },
  ]);

  const code = await runRemoteCp(["ubuntu:/var/log/app.log", dir], {
    config,
    fetch,
    console: makeConsole(),
  });

  assert.equal(code, 0);
  assert.deepEqual(await fsp.readFile(path.join(dir, "app.log")), payload);

  await fsp.rm(dir, { recursive: true, force: true });
});

test("runRemoteCp refuses a corrupted download and leaves no partial file", async () => {
  const dir = await makeTempDir();
  const destination = path.join(dir, "out.bin");
  const consoleImpl = makeConsole();

  const { fetch } = makeFetch([
    {
      body: {
        transferId: "t-4",
        status: "ready",
        sizeBytes: 7,
        sha256: sha256(Buffer.from("expected")),
        name: "out.bin",
      },
    },
    { bytes: Buffer.from("corrupt") },
  ]);

  const code = await runRemoteCp(["ubuntu:/tmp/out.bin", destination], {
    config,
    fetch,
    console: consoleImpl,
  });

  assert.equal(code, 255);
  assert.ok(consoleImpl.errors.some((line) => line.includes("checksum mismatch")));
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(await fsp.readdir(dir), []);

  await fsp.rm(dir, { recursive: true, force: true });
});

test("runRemoteCp rejects a directory source before touching the network", async () => {
  const dir = await makeTempDir();
  const consoleImpl = makeConsole();
  const { fetch, calls } = makeFetch([]);

  const code = await runRemoteCp([dir, "ubuntu:/srv/x"], {
    config,
    fetch,
    console: consoleImpl,
  });

  assert.equal(code, 255);
  assert.equal(calls.length, 0);
  assert.ok(consoleImpl.errors.some((line) => line.includes("pass -r to copy it recursively")));

  await fsp.rm(dir, { recursive: true, force: true });
});

test("runRemoteCp rejects daemon-to-daemon and local-to-local copies", async () => {
  const both = makeConsole();
  assert.equal(await runRemoteCp(["a:/x", "b:/y"], { config, fetch: async () => {}, console: both }), 255);
  assert.ok(both.errors.some((line) => line.includes("one side must be local")));

  const neither = makeConsole();
  assert.equal(await runRemoteCp(["./x", "./y"], { config, fetch: async () => {}, console: neither }), 255);
  assert.ok(neither.errors.some((line) => line.includes("must name a daemon")));
});

test("runRemoteCp surfaces a missing local source", async () => {
  const consoleImpl = makeConsole();
  const code = await runRemoteCp(["/nope/missing.bin", "ubuntu:/srv/x"], {
    config,
    fetch: async () => {
      throw new Error("should not reach the network");
    },
    console: consoleImpl,
  });
  assert.equal(code, 255);
  assert.ok(consoleImpl.errors.some((line) => line.includes("no such file")));
});

test("runRemoteCp surfaces a daemon-side failure reported as HTTP 200", async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "a.bin");
  await fsp.writeFile(source, "x");
  const consoleImpl = makeConsole();

  const { fetch } = makeFetch([
    { body: { transferId: "t-5", status: "staged" } },
    { body: { transferId: "t-5", status: "uploaded" } },
    { body: { transferId: "t-5", status: "failed", error: "permission denied: /srv/x" } },
  ]);

  const code = await runRemoteCp([source, "ubuntu:/srv/x"], {
    config,
    fetch,
    console: consoleImpl,
  });

  assert.equal(code, 255);
  assert.ok(consoleImpl.errors.some((line) => line.includes("permission denied")));

  await fsp.rm(dir, { recursive: true, force: true });
});

test("runRemoteCp reports the path the daemon actually wrote to", async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "a.bin");
  await fsp.writeFile(source, "x");
  const consoleImpl = makeConsole();

  const { fetch } = makeFetch([
    { body: { transferId: "t-6", status: "staged" } },
    { body: { transferId: "t-6", status: "uploaded" } },
    // Destination was a directory, so the daemon resolved it to a real filename.
    { body: { transferId: "t-6", status: "ready", path: "/srv/a.bin", bytesWritten: 1 } },
  ]);

  assert.equal(await runRemoteCp([source, "ubuntu:/srv"], { config, fetch, console: consoleImpl }), 0);
  assert.ok(consoleImpl.errors.some((line) => line.includes("ubuntu:/srv/a.bin")));

  await fsp.rm(dir, { recursive: true, force: true });
});

test("runRemoteCp surfaces a download the daemon could not start", async () => {
  const consoleImpl = makeConsole();
  const { fetch } = makeFetch([
    { body: { transferId: "t-7", status: "failed", error: "no such file: /var/log/nope" } },
  ]);

  const code = await runRemoteCp(["ubuntu:/var/log/nope", "./out.log"], {
    config,
    fetch,
    console: consoleImpl,
  });

  assert.equal(code, 255);
  assert.ok(consoleImpl.errors.some((line) => line.includes("no such file")));
});

test("runRemoteCp names a missing destination directory before transferring bytes", async () => {
  const dir = await makeTempDir();
  const consoleImpl = makeConsole();
  const payload = Buffer.from("x");

  const { fetch, calls } = makeFetch([
    {
      body: {
        transferId: "t-8",
        status: "ready",
        sizeBytes: payload.length,
        sha256: sha256(payload),
        name: "a.txt",
      },
    },
  ]);

  const code = await runRemoteCp(
    ["ubuntu:/var/log/a.txt", path.join(dir, "missing", "a.txt")],
    { config, fetch, console: consoleImpl },
  );

  assert.equal(code, 255);
  assert.ok(
    consoleImpl.errors.some((line) => line.includes("destination directory does not exist")),
    consoleImpl.errors.join(" | "),
  );
  // Only the create call happened; the content stream was never opened.
  assert.equal(calls.length, 1);

  await fsp.rm(dir, { recursive: true, force: true });
});

test("runRemoteCp refuses to write a download the backend did not checksum", async () => {
  const dir = await makeTempDir();
  const destination = path.join(dir, "unverified.bin");
  const consoleImpl = makeConsole();

  // Regression: the backend used to answer the down-direction create with only
  // `{transferId, status}`. `if (created.sha256 && ...)` then silently passed
  // and every corrupt download was renamed into place with exit code 0.
  const { fetch } = makeFetch([
    { body: { transferId: "t-9", status: "ready" } },
    { bytes: Buffer.from("whatever") },
  ]);

  const code = await runRemoteCp(["ubuntu:/tmp/x.bin", destination], {
    config,
    fetch,
    console: consoleImpl,
  });

  assert.equal(code, 255);
  assert.ok(
    consoleImpl.errors.some((line) => line.includes("did not report a checksum")),
    consoleImpl.errors.join(" | "),
  );
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(await fsp.readdir(dir), []);

  await fsp.rm(dir, { recursive: true, force: true });
});

test("runRemoteCp refuses a download the backend did not size", async () => {
  const dir = await makeTempDir();
  const payload = Buffer.from("sized?");
  const consoleImpl = makeConsole();

  const { fetch } = makeFetch([
    { body: { transferId: "t-10", status: "ready", sha256: sha256(payload) } },
    { bytes: payload },
  ]);

  const code = await runRemoteCp(["ubuntu:/tmp/x.bin", path.join(dir, "x.bin")], {
    config,
    fetch,
    console: consoleImpl,
  });

  assert.equal(code, 255);
  assert.ok(consoleImpl.errors.some((line) => line.includes("did not report a size")));

  await fsp.rm(dir, { recursive: true, force: true });
});

test("runRemoteCp releases the transfer after a successful download", async () => {
  const dir = await makeTempDir();
  const payload = Buffer.from("release me");
  const { fetch, calls } = makeFetch([
    {
      body: {
        transferId: "t-11",
        status: "ready",
        sizeBytes: payload.length,
        sha256: sha256(payload),
        name: "x.bin",
      },
    },
    { bytes: payload },
    { body: { transferId: "t-11", status: "cancelled" } },
  ]);

  const code = await runRemoteCp(["ubuntu:/tmp/x.bin", path.join(dir, "x.bin")], {
    config,
    fetch,
    console: makeConsole(),
  });

  assert.equal(code, 0);
  // Without this the server holds the slot until the TTL sweep, so four quick
  // copies in a row would 429 the fifth.
  const release = calls.at(-1);
  assert.equal(release.init.method, "DELETE");
  assert.match(release.url, /\/api\/agents\/ubuntu\/files\/t-11$/);

  await fsp.rm(dir, { recursive: true, force: true });
});

test("runRemoteCp still succeeds when releasing the transfer fails", async () => {
  const dir = await makeTempDir();
  const payload = Buffer.from("kept anyway");
  const { fetch } = makeFetch([
    {
      body: {
        transferId: "t-12",
        status: "ready",
        sizeBytes: payload.length,
        sha256: sha256(payload),
        name: "x.bin",
      },
    },
    { bytes: payload },
    { status: 500, body: { error: "boom" } },
  ]);

  const destination = path.join(dir, "x.bin");
  assert.equal(
    await runRemoteCp(["ubuntu:/tmp/x.bin", destination], {
      config,
      fetch,
      console: makeConsole(),
    }),
    0,
    "a failed cleanup must not fail a completed download",
  );
  assert.deepEqual(await fsp.readFile(destination), payload);

  await fsp.rm(dir, { recursive: true, force: true });
});

test("parseCpArgs understands -r and --recursive", () => {
  assert.equal(parseCpArgs(["-r", "./d", "ubuntu:/srv"]).options.recursive, true);
  assert.equal(parseCpArgs(["--recursive", "./d", "ubuntu:/srv"]).options.recursive, true);
  assert.equal(parseCpArgs(["./d", "ubuntu:/srv"]).options.recursive, false);
});

test("chunkBytes is 32 MiB unless overridden", () => {
  assert.equal(chunkBytes({}), 32 * 1024 * 1024);
  assert.equal(chunkBytes({ CONDUCTOR_REMOTE_CHUNK_BYTES: "1048576" }), 1048576);
  // Junk must not silently produce a zero-size chunk and an infinite loop.
  assert.equal(chunkBytes({ CONDUCTOR_REMOTE_CHUNK_BYTES: "0" }), 32 * 1024 * 1024);
  assert.equal(chunkBytes({ CONDUCTOR_REMOTE_CHUNK_BYTES: "nope" }), 32 * 1024 * 1024);
});
