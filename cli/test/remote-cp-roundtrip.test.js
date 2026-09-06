/**
 * Round-trip integration: the real `conductor remote cp` client against the
 * real daemon handler, with a stand-in backend in between.
 *
 * The two sides were written independently against RFC 0037, and their unit
 * tests each mock the other. This is the only test that makes the actual field
 * names, path resolution and checksum handling meet, which is exactly where a
 * three-sided protocol drifts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";

import { ConductorConfig } from "@love-moon/conductor-sdk";
import { runRemoteCp } from "../src/remote/cp.js";
import { createRemoteFileHandlers } from "../src/remote-file-handlers.js";
import { execFile } from "node:child_process";

const config = new ConductorConfig({
  agentToken: "test-token",
  backendUrl: "http://backend.test",
});

function makeConsole() {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    log: (...a) => logs.push(a.join(" ")),
    error: (...a) => errors.push(a.join(" ")),
  };
}

function parseContentRange(value) {
  const match = typeof value === "string" && value.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  return match
    ? { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) }
    : null;
}

function parseRangeFrom(value) {
  const match = typeof value === "string" && value.match(/^bytes=(\d+)-$/);
  return match ? Number(match[1]) : null;
}

const makeTempDir = () => fsp.mkdtemp(path.join(os.tmpdir(), "conductor-roundtrip-"));

async function drainBody(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  const chunks = [];
  for await (const chunk of Readable.fromWeb(body)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const json = (value, status = 200) => ({
  ok: status < 400,
  status,
  body: null,
  text: async () => JSON.stringify(value),
});

const octet = (buffer, status = 200) => ({
  ok: status < 400,
  status,
  body: Readable.toWeb(Readable.from([buffer])),
  text: async () => buffer.toString(),
});

/**
 * A minimal stand-in for the Web backend: it stages bytes on disk and relays
 * the control step to the daemon handler, which is the real one.
 */
function makeBackend(stagingDir) {
  const transfers = new Map();
  const execCalls = [];
  /** @type {{dispatch: Function}|null} */
  let daemon = null;

  const backend = {
    transfers,
    execCalls,
    attachDaemon(handlers) {
      daemon = handlers;
    },
    stagedPath: (id) => path.join(stagingDir, `${id}.bin`),

    async fetch(url, init = {}) {
      const { pathname } = new URL(url);
      const method = (init.method || "GET").toUpperCase();

      // --- CLI-facing: run a command on the target ----------------------
      const ex = pathname.match(/^\/api\/agents\/[^/]+\/exec$/);
      if (ex && method === "POST") {
        const { command, args = [] } = JSON.parse(init.body);
        execCalls.push({ command, args });
        const run = await new Promise((resolve) => {
          execFile(command, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({
              runId: randomUUID(),
              status: error ? "failed" : "completed",
              exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
              stdoutTail: String(stdout || ""),
              stderrTail: String(stderr || ""),
              truncated: false,
              error: null,
            });
          });
        });
        return json(run);
      }

      // --- CLI-facing: release a finished transfer ----------------------
      let m = pathname.match(/^\/api\/agents\/[^/]+\/files\/([^/]+)$/);
      if (m && method === "DELETE") {
        transfers.delete(m[1]);
        await fsp.rm(backend.stagedPath(m[1]), { force: true });
        return json({ transferId: m[1], status: "cancelled" });
      }

      // --- CLI-facing: create a transfer -------------------------------
      m = pathname.match(/^\/api\/agents\/([^/]+)\/files$/);
      if (m && method === "POST") {
        const input = JSON.parse(init.body);
        const transferId = randomUUID();
        const record = { transferId, agentHost: m[1], ...input, status: "staged" };
        transfers.set(transferId, record);

        if (input.direction === "down") {
          // The backend asks the daemon to push before answering the CLI.
          const outcome = await daemon.dispatch({
            action: "push",
            args: { transferId, transferToken: "tok", remotePath: input.remotePath },
          });
          if (outcome.error) {
            return json({ transferId, status: "failed", error: outcome.error });
          }
          Object.assign(record, outcome.result, { status: "ready" });
          // Mirror the real route's `transferSummary` field-for-field. Echoing
          // the whole record instead is what let a backend that omitted
          // `sha256` slip through: the CLI's verification silently became a
          // no-op and this suite stayed green.
          return json({
            transferId: record.transferId,
            direction: record.direction,
            status: record.status,
            sizeBytes: record.sizeBytes,
            sha256: record.sha256,
            mode: record.mode,
            name: record.name,
            remotePath: record.remotePath,
            error: record.error ?? null,
          });
        }
        return json({ transferId: record.transferId, status: record.status });
      }

      // --- CLI-facing: upload bytes ------------------------------------
      m = pathname.match(/^\/api\/agents\/[^/]+\/files\/([^/]+)\/content$/);
      if (m && method === "PUT") {
        const record = transfers.get(m[1]);
        const bytes = await drainBody(init.body);
        // Honour Content-Range exactly like the real route. Overwriting instead
        // would make every multi-chunk upload silently keep only the last part
        // while these tests stayed green.
        const range = parseContentRange(init.headers?.["Content-Range"]);
        const staged = backend.stagedPath(m[1]);
        const have = await fsp.stat(staged).then((st) => st.size).catch(() => 0);
        if (range && range.start !== have) {
          return json({ error: "offset mismatch", receivedBytes: have }, 409);
        }
        await fsp.writeFile(staged, bytes, { flag: range && range.start > 0 ? "a" : "w" });
        const received = await fsp.stat(staged).then((st) => st.size);
        const total = range ? range.total : bytes.length;
        record.status = received >= total ? "uploaded" : "staged";
        return json({
          transferId: m[1],
          status: record.status,
          receivedBytes: received,
          complete: received >= total,
        });
      }

      // --- CLI-facing: download bytes ----------------------------------
      if (m && method === "GET") {
        const all = await fsp.readFile(backend.stagedPath(m[1]));
        const from = parseRangeFrom(init.headers?.Range);
        if (from === null) return octet(all);
        if (from >= all.length) return { ok: false, status: 416, body: null, text: async () => "" };
        return { ...octet(all.subarray(from)), status: 206, ok: true };
      }

      // --- CLI-facing: hand the upload to the daemon --------------------
      m = pathname.match(/^\/api\/agents\/[^/]+\/files\/([^/]+)\/deliver$/);
      if (m && method === "POST") {
        const record = transfers.get(m[1]);
        const outcome = await daemon.dispatch({
          action: "pull",
          args: {
            transferId: record.transferId,
            transferToken: "tok",
            remotePath: record.remotePath,
            name: record.name,
            sha256: record.sha256,
            sizeBytes: record.sizeBytes,
            mode: record.mode,
          },
        });
        if (outcome.error) {
          return json({ transferId: m[1], status: "failed", error: outcome.error });
        }
        return json({ transferId: m[1], status: "ready", ...outcome.result });
      }

      // --- daemon-facing: daemon pulls staged bytes ---------------------
      m = pathname.match(/^\/api\/agent\/files\/([^/]+)\/content$/);
      if (m && method === "GET") {
        const bytes = await fsp.readFile(backend.stagedPath(m[1]));
        return {
          ok: true,
          status: 200,
          headers: new Map([["content-length", String(bytes.length)]]),
          body: Readable.toWeb(Readable.from([bytes])),
          text: async () => bytes.toString(),
        };
      }

      // --- daemon-facing: daemon pushes bytes up ------------------------
      if (m && method === "PUT") {
        const bytes = await drainBody(init.body);
        await fsp.writeFile(backend.stagedPath(m[1]), bytes);
        return json({ transferId: m[1], status: "uploaded", sizeBytes: bytes.length });
      }

      throw new Error(`stand-in backend has no route for ${method} ${pathname}`);
    },
  };
  return backend;
}

async function setup() {
  const root = await makeTempDir();
  const staging = path.join(root, "staging");
  const localDir = path.join(root, "local");
  const remoteDir = path.join(root, "remote");
  await Promise.all([
    fsp.mkdir(staging, { recursive: true }),
    fsp.mkdir(localDir, { recursive: true }),
    fsp.mkdir(remoteDir, { recursive: true }),
  ]);

  const backend = makeBackend(staging);
  const daemon = createRemoteFileHandlers({
    config,
    agentHost: "ubuntu",
    fetchImpl: backend.fetch,
  });
  backend.attachDaemon(daemon);

  return { root, staging, localDir, remoteDir, backend, daemon };
}

test("round trip: upload a file, then download it back byte-identical", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  // Big enough to span several stream chunks, and binary so a text-mode bug shows.
  const payload = Buffer.concat(
    Array.from({ length: 400 }, (_, i) => Buffer.from([i % 256, 0, 255, 7])),
  );
  const source = path.join(localDir, "build.tar.gz");
  await fsp.writeFile(source, payload);

  const remoteTarget = path.join(remoteDir, "build.tar.gz");
  const up = makeConsole();
  assert.equal(
    await runRemoteCp([source, `ubuntu:${remoteTarget}`], {
      config,
      fetch: backend.fetch,
      console: up,
    }),
    0,
    up.errors.join("\n"),
  );
  assert.deepEqual(await fsp.readFile(remoteTarget), payload);

  const readBack = path.join(localDir, "roundtrip.tar.gz");
  const down = makeConsole();
  assert.equal(
    await runRemoteCp([`ubuntu:${remoteTarget}`, readBack], {
      config,
      fetch: backend.fetch,
      console: down,
    }),
    0,
    down.errors.join("\n"),
  );
  assert.deepEqual(await fsp.readFile(readBack), payload);

  await fsp.rm(root, { recursive: true, force: true });
});

test("round trip: uploading onto an existing remote directory keeps the source name", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const payload = Buffer.from("keeps its name");
  const source = path.join(localDir, "report.json");
  await fsp.writeFile(source, payload);

  const consoleImpl = makeConsole();
  assert.equal(
    await runRemoteCp([source, `ubuntu:${remoteDir}`], {
      config,
      fetch: backend.fetch,
      console: consoleImpl,
    }),
    0,
    consoleImpl.errors.join("\n"),
  );

  // This is the seam the deliver route's `name` field exists for.
  assert.deepEqual(await fsp.readFile(path.join(remoteDir, "report.json")), payload);
  assert.ok(consoleImpl.errors.some((line) => line.includes("report.json")));

  await fsp.rm(root, { recursive: true, force: true });
});

test("round trip: file mode survives the upload", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const source = path.join(localDir, "run.sh");
  await fsp.writeFile(source, "#!/bin/sh\necho hi\n", { mode: 0o755 });
  await fsp.chmod(source, 0o755);

  const target = path.join(remoteDir, "run.sh");
  assert.equal(
    await runRemoteCp([source, `ubuntu:${target}`], {
      config,
      fetch: backend.fetch,
      console: makeConsole(),
    }),
    0,
  );
  assert.equal((await fsp.stat(target)).mode & 0o777, 0o755);

  await fsp.rm(root, { recursive: true, force: true });
});

test("round trip: a missing remote file fails cleanly and writes nothing locally", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const destination = path.join(localDir, "nope.log");
  const consoleImpl = makeConsole();

  const code = await runRemoteCp(
    [`ubuntu:${path.join(remoteDir, "absent.log")}`, destination],
    { config, fetch: backend.fetch, console: consoleImpl },
  );

  assert.equal(code, 255);
  assert.ok(consoleImpl.errors.some((line) => line.includes("no such file")));
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(await fsp.readdir(localDir), []);

  await fsp.rm(root, { recursive: true, force: true });
});

test("round trip: a remote directory is refused rather than silently skipped", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const consoleImpl = makeConsole();

  const code = await runRemoteCp([`ubuntu:${remoteDir}`, path.join(localDir, "x")], {
    config,
    fetch: backend.fetch,
    console: consoleImpl,
  });

  assert.equal(code, 255);
  assert.ok(consoleImpl.errors.some((line) => line.includes("is a directory")));

  await fsp.rm(root, { recursive: true, force: true });
});

test("round trip: an existing remote file is not truncated when the transfer fails", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const target = path.join(remoteDir, "precious.conf");
  const original = Buffer.from("do not lose me\n");
  await fsp.writeFile(target, original);

  const source = path.join(localDir, "replacement.conf");
  await fsp.writeFile(source, "new contents");

  // Corrupt the staged bytes after the CLI uploads them, keeping the length
  // identical so the Content-Length assert cannot catch it and the SHA-256
  // check is the only thing standing between us and a silently wrong file.
  const realFetch = backend.fetch;
  const consoleImpl = makeConsole();
  const code = await runRemoteCp([source, `ubuntu:${target}`], {
    config,
    console: consoleImpl,
    fetch: async (url, init) => {
      const response = await realFetch(url, init);
      if (/\/files\/[^/]+\/content$/.test(new URL(url).pathname) && init?.method === "PUT") {
        const id = new URL(url).pathname.split("/").at(-2);
        await fsp.writeFile(backend.stagedPath(id), "XXXXXXXXXXXX");
      }
      return response;
    },
  });

  assert.equal(code, 255);
  assert.ok(
    consoleImpl.errors.some((line) => line.includes("SHA-256 mismatch")),
    `expected a checksum failure, got: ${consoleImpl.errors.join(" | ")}`,
  );
  assert.deepEqual(await fsp.readFile(target), original, "existing file must survive a failed copy");
  assert.deepEqual(
    (await fsp.readdir(remoteDir)).filter((n) => n.includes(".part")),
    [],
    "no .part leftovers",
  );

  await fsp.rm(root, { recursive: true, force: true });
});

test("round trip: stat reports what the daemon sees", async () => {
  const { root, remoteDir, daemon } = await setup();
  const target = path.join(remoteDir, "a.txt");
  await fsp.writeFile(target, "abc");

  const present = await daemon.dispatch({ action: "stat", args: { remotePath: target } });
  assert.equal(present.result.exists, true);
  assert.equal(present.result.isFile, true);
  assert.equal(present.result.sizeBytes, 3);

  const absent = await daemon.dispatch({
    action: "stat",
    args: { remotePath: path.join(remoteDir, "ghost") },
  });
  assert.equal(absent.result.exists, false);

  await fsp.rm(root, { recursive: true, force: true });
});

test("round trip: checksums are computed over the real bytes on both sides", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const payload = Buffer.from("checksum me");
  const source = path.join(localDir, "c.bin");
  await fsp.writeFile(source, payload);
  const expected = createHash("sha256").update(payload).digest("hex");

  const target = path.join(remoteDir, "c.bin");
  assert.equal(
    await runRemoteCp([source, `ubuntu:${target}`], {
      config,
      fetch: backend.fetch,
      console: makeConsole(),
    }),
    0,
  );

  const record = [...backend.transfers.values()][0];
  assert.equal(record.sha256, expected, "CLI hashed the file it sent");

  const readBack = path.join(localDir, "c-back.bin");
  assert.equal(
    await runRemoteCp([`ubuntu:${target}`, readBack], {
      config,
      fetch: backend.fetch,
      console: makeConsole(),
    }),
    0,
  );
  const downRecord = [...backend.transfers.values()].at(-1);
  assert.equal(downRecord.sha256, expected, "daemon hashed the file it sent");

  await fsp.rm(root, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// Recursive (-r). These run real `tar` and the real `sh` extract script, so a
// mistake in either the archive helpers or the shell quoting shows up as a
// wrong tree on disk rather than a passing mock.
// ---------------------------------------------------------------------------

/** Snapshot a tree as sorted "relative-path mode contents" lines. */
async function snapshotTree(root) {
  const out = [];
  async function walk(dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        out.push(`${rel} dir`);
        await walk(full);
      } else if (entry.isSymbolicLink()) {
        out.push(`${rel} link ${await fsp.readlink(full)}`);
      } else {
        const stat = await fsp.stat(full);
        out.push(`${rel} ${(stat.mode & 0o777).toString(8)} ${await fsp.readFile(full, "utf8")}`);
      }
    }
  }
  await walk(root);
  return out.sort();
}

async function makeTree(root) {
  await fsp.mkdir(path.join(root, "nested", "deep"), { recursive: true });
  await fsp.writeFile(path.join(root, "top.txt"), "top level\n");
  await fsp.writeFile(path.join(root, "nested", "middle.json"), '{"a":1}\n');
  await fsp.writeFile(path.join(root, "nested", "deep", "leaf.md"), "# leaf\n");
  await fsp.writeFile(path.join(root, "run.sh"), "#!/bin/sh\necho hi\n");
  await fsp.chmod(path.join(root, "run.sh"), 0o755);
  await fsp.symlink("top.txt", path.join(root, "link-to-top"));
  return root;
}

test("recursive upload reproduces the whole tree, with modes and symlinks", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const source = await makeTree(path.join(localDir, "dist"));
  const before = await snapshotTree(source);

  const consoleImpl = makeConsole();
  const code = await runRemoteCp(["-r", source, `ubuntu:${remoteDir}`], {
    config,
    fetch: backend.fetch,
    console: consoleImpl,
  });

  assert.equal(code, 0, consoleImpl.errors.join("\n"));
  // Existing destination directory receives the source inside it, like scp.
  assert.deepEqual(await snapshotTree(path.join(remoteDir, "dist")), before);

  await fsp.rm(root, { recursive: true, force: true });
});

test("recursive download reproduces the whole tree", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const source = await makeTree(path.join(remoteDir, "logs"));
  const before = await snapshotTree(source);

  const destination = path.join(localDir, "pulled");
  const consoleImpl = makeConsole();
  const code = await runRemoteCp(["-r", `ubuntu:${source}`, destination], {
    config,
    fetch: backend.fetch,
    console: consoleImpl,
  });

  assert.equal(code, 0, consoleImpl.errors.join("\n"));
  // Missing destination becomes the copy itself, like scp.
  assert.deepEqual(await snapshotTree(destination), before);

  await fsp.rm(root, { recursive: true, force: true });
});

test("recursive copy cleans up its tarball on the target", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const source = await makeTree(path.join(localDir, "dist"));

  assert.equal(
    await runRemoteCp(["-r", source, `ubuntu:${remoteDir}`], {
      config,
      fetch: backend.fetch,
      console: makeConsole(),
    }),
    0,
  );

  const cleanup = backend.execCalls.at(-1);
  assert.match(cleanup.args[1], /^rm -f/);
  assert.equal(fs.existsSync(cleanup.args.at(-1)), false, "remote tarball must not survive");
  assert.deepEqual((await fsp.readdir(remoteDir)).sort(), ["dist"]);

  await fsp.rm(root, { recursive: true, force: true });
});

test("recursive copy passes paths as argv, so shell metacharacters are inert", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  // A directory name that would be catastrophic if it were ever interpolated
  // into the remote shell script.
  const nasty = path.join(localDir, "a b; touch /tmp/conductor-pwned");
  await makeTree(nasty);

  const consoleImpl = makeConsole();
  const code = await runRemoteCp(["-r", nasty, `ubuntu:${remoteDir}`], {
    config,
    fetch: backend.fetch,
    console: consoleImpl,
  });

  assert.equal(code, 0, consoleImpl.errors.join("\n"));
  assert.equal(fs.existsSync("/tmp/conductor-pwned"), false, "the name must never be executed");
  assert.deepEqual((await fsp.readdir(remoteDir)).sort(), [path.basename(nasty)]);
  assert.deepEqual(
    await snapshotTree(path.join(remoteDir, path.basename(nasty))),
    await snapshotTree(nasty),
  );
  // Every path reached the target as a positional argument, never as script text.
  for (const call of backend.execCalls) {
    assert.equal(call.command, "sh");
    assert.equal(call.args[0], "-c");
    assert.ok(!call.args[1].includes(path.basename(nasty)), "path must not be inside the script");
  }

  await fsp.rm(root, { recursive: true, force: true });
});

test("recursive download of a path that is not a directory fails clearly", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const file = path.join(remoteDir, "just-a-file.txt");
  await fsp.writeFile(file, "hello");

  const consoleImpl = makeConsole();
  const code = await runRemoteCp(["-r", `ubuntu:${file}`, path.join(localDir, "out")], {
    config,
    fetch: backend.fetch,
    console: consoleImpl,
  });

  assert.equal(code, 255);
  assert.ok(
    consoleImpl.errors.some((line) => line.includes("not a directory")),
    consoleImpl.errors.join(" | "),
  );

  await fsp.rm(root, { recursive: true, force: true });
});

test("-r on a plain file still just copies the file, like scp", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const source = path.join(localDir, "single.txt");
  await fsp.writeFile(source, "not a tree");

  const consoleImpl = makeConsole();
  const target = path.join(remoteDir, "single.txt");
  const code = await runRemoteCp(["-r", source, `ubuntu:${target}`], {
    config,
    fetch: backend.fetch,
    console: consoleImpl,
  });

  assert.equal(code, 0, consoleImpl.errors.join("\n"));
  assert.equal(await fsp.readFile(target, "utf8"), "not a tree");
  assert.equal(backend.execCalls.length, 0, "no tar should be involved");

  await fsp.rm(root, { recursive: true, force: true });
});

test("recursive copy keeps the archive steps inside --timeout", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const source = await makeTree(path.join(localDir, "dist"));

  const seen = [];
  const consoleImpl = makeConsole();
  await runRemoteCp(["-r", "--timeout", "20s", source, `ubuntu:${remoteDir}`], {
    config,
    console: consoleImpl,
    fetch: async (url, init) => {
      if (/\/exec$/.test(new URL(url).pathname) && init?.method === "POST") {
        seen.push(JSON.parse(init.body).timeoutMs);
      }
      return backend.fetch(url, init);
    },
  });

  // `exec` caps a single blocking request at 10s, so the clamp shows up as
  // "never more than the user's own budget" rather than an exact figure.
  assert.ok(seen.length > 0, "an archive step should have run");
  for (const ms of seen) assert.ok(ms <= 20_000, `archive step asked for ${ms}ms of a 20s budget`);

  await fsp.rm(root, { recursive: true, force: true });
});


test("recursive download does not disturb a neighbour sharing the source name", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const source = await makeTree(path.join(remoteDir, "dist"));

  // A local directory that happens to share the remote source's name, sitting
  // right next to where we are about to write. Extracting into the parent
  // instead of a staging dir used to move this away.
  const bystander = path.join(localDir, "dist");
  await fsp.mkdir(bystander, { recursive: true });
  await fsp.writeFile(path.join(bystander, "mine.txt"), "do not touch\n");

  const consoleImpl = makeConsole();
  const code = await runRemoteCp(["-r", `ubuntu:${source}`, path.join(localDir, "copy")], {
    config,
    fetch: backend.fetch,
    console: consoleImpl,
  });

  assert.equal(code, 0, consoleImpl.errors.join("\n"));
  assert.equal(
    await fsp.readFile(path.join(bystander, "mine.txt"), "utf8"),
    "do not touch\n",
    "the neighbour must survive untouched",
  );
  assert.deepEqual(await snapshotTree(path.join(localDir, "copy")), await snapshotTree(source));
  // No staging directory left behind either.
  assert.deepEqual(
    (await fsp.readdir(localDir)).filter((n) => n.startsWith(".conductor-rcp-")),
    [],
  );

  await fsp.rm(root, { recursive: true, force: true });
});

test("recursive upload does not disturb a neighbour sharing the source name", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const source = await makeTree(path.join(localDir, "dist"));

  const bystander = path.join(remoteDir, "dist");
  await fsp.mkdir(bystander, { recursive: true });
  await fsp.writeFile(path.join(bystander, "theirs.txt"), "keep me\n");

  const consoleImpl = makeConsole();
  const code = await runRemoteCp(["-r", source, `ubuntu:${path.join(remoteDir, "copy")}`], {
    config,
    fetch: backend.fetch,
    console: consoleImpl,
  });

  assert.equal(code, 0, consoleImpl.errors.join("\n"));
  assert.equal(await fsp.readFile(path.join(bystander, "theirs.txt"), "utf8"), "keep me\n");
  assert.deepEqual(await snapshotTree(path.join(remoteDir, "copy")), await snapshotTree(source));
  assert.deepEqual(
    (await fsp.readdir(remoteDir)).filter((n) => n.startsWith(".conductor-rcp-")),
    [],
  );

  await fsp.rm(root, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// Chunked upload and resume. CONDUCTOR_REMOTE_CHUNK_BYTES is shrunk so a few
// hundred bytes exercise the same multi-chunk path a 100 MB file would.
// ---------------------------------------------------------------------------

const TINY_CHUNK = { CONDUCTOR_REMOTE_CHUNK_BYTES: "64" };

test("upload splits into ranged chunks that reassemble exactly", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  // 10 chunks worth, with a partial last one, and binary so a text-mode bug shows.
  const payload = Buffer.from(
    Array.from({ length: 650 }, (_, i) => (i * 7) % 256),
  );
  const source = path.join(localDir, "big.bin");
  await fsp.writeFile(source, payload);

  const ranges = [];
  const target = path.join(remoteDir, "big.bin");
  const code = await runRemoteCp([source, `ubuntu:${target}`], {
    config,
    console: makeConsole(),
    env: TINY_CHUNK,
    fetch: async (url, init) => {
      const cr = init?.headers?.["Content-Range"];
      if (cr) ranges.push(cr);
      return backend.fetch(url, init);
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(await fsp.readFile(target), payload);
  assert.equal(ranges.length, Math.ceil(payload.length / 64), "one request per chunk");
  assert.equal(ranges[0], `bytes 0-63/${payload.length}`);
  assert.equal(ranges.at(-1), `bytes 640-649/${payload.length}`);

  await fsp.rm(root, { recursive: true, force: true });
});

test("upload resumes from the server's offset after a mid-transfer failure", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const payload = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256));
  const source = path.join(localDir, "resume.bin");
  await fsp.writeFile(source, payload);

  let failures = 0;
  const target = path.join(remoteDir, "resume.bin");
  const code = await runRemoteCp([source, `ubuntu:${target}`], {
    config,
    console: makeConsole(),
    env: TINY_CHUNK,
    sleep: async () => {},
    fetch: async (url, init) => {
      // Drop the third chunk once, the way a blip would.
      if (init?.headers?.["Content-Range"] === "bytes 128-191/300" && failures === 0) {
        failures += 1;
        throw new Error("socket hang up");
      }
      return backend.fetch(url, init);
    },
  });

  assert.equal(code, 0);
  assert.equal(failures, 1, "the failure should actually have been injected");
  assert.deepEqual(await fsp.readFile(target), payload, "resumed upload must be byte-exact");

  await fsp.rm(root, { recursive: true, force: true });
});

test("upload obeys a 409 by seeking to the offset the server reports", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const payload = Buffer.from(Array.from({ length: 200 }, (_, i) => i % 256));
  const source = path.join(localDir, "seek.bin");
  await fsp.writeFile(source, payload);

  let injected = false;
  const target = path.join(remoteDir, "seek.bin");
  const code = await runRemoteCp([source, `ubuntu:${target}`], {
    config,
    console: makeConsole(),
    env: TINY_CHUNK,
    sleep: async () => {},
    fetch: async (url, init) => {
      // Pretend the server already holds the first two chunks.
      if (init?.headers?.["Content-Range"] === "bytes 0-63/200" && !injected) {
        injected = true;
        const staged = backend.stagedPath([...backend.transfers.keys()][0]);
        await fsp.writeFile(staged, payload.subarray(0, 128));
      }
      return backend.fetch(url, init);
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(await fsp.readFile(target), payload);

  await fsp.rm(root, { recursive: true, force: true });
});

test("download resumes from the local partial file", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const payload = Buffer.from(Array.from({ length: 400 }, (_, i) => (i * 3) % 256));
  const source = path.join(remoteDir, "pull.bin");
  await fsp.writeFile(source, payload);

  const destination = path.join(localDir, "pull.bin");
  const rangeHeaders = [];
  let truncated = false;

  const code = await runRemoteCp([`ubuntu:${source}`, destination], {
    config,
    console: makeConsole(),
    sleep: async () => {},
    fetch: async (url, init) => {
      if (init?.headers?.Range) rangeHeaders.push(init.headers.Range);
      const response = await backend.fetch(url, init);
      // First content GET: hand back only a prefix, as a cut connection would.
      if (!truncated && response.status === 200 && response.body) {
        truncated = true;
        return { ...response, body: Readable.toWeb(Readable.from([payload.subarray(0, 150)])) };
      }
      return response;
    },
  });

  assert.equal(code, 0, "a short read must be resumed, not fatal");
  assert.deepEqual(await fsp.readFile(destination), payload);
  assert.deepEqual(rangeHeaders, ["bytes=150-"], "resumed exactly from what was already on disk");
  assert.equal(fs.existsSync(`${destination}.${process.pid}.part`), false);

  await fsp.rm(root, { recursive: true, force: true });
});

test("download treats 416 as 'already complete' and still verifies", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const payload = Buffer.from("already here");
  const source = path.join(remoteDir, "done.bin");
  await fsp.writeFile(source, payload);

  const destination = path.join(localDir, "done.bin");
  const code = await runRemoteCp([`ubuntu:${source}`, destination], {
    config,
    console: makeConsole(),
    sleep: async () => {},
    fetch: async (url, init) => {
      const response = await backend.fetch(url, init);
      // Pre-fill the partial, then answer the range request with 416.
      if (response.status === 200 && response.body && /\/content$/.test(new URL(url).pathname)) {
        await fsp.writeFile(`${destination}.${process.pid}.part`, payload);
        return { ok: false, status: 416, body: null, text: async () => "" };
      }
      return response;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(await fsp.readFile(destination), payload);

  await fsp.rm(root, { recursive: true, force: true });
});

test("a resumed download that assembles to the wrong bytes is still rejected", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const payload = Buffer.from(Array.from({ length: 200 }, (_, i) => i % 256));
  const source = path.join(remoteDir, "corrupt.bin");
  await fsp.writeFile(source, payload);

  const destination = path.join(localDir, "corrupt.bin");
  const consoleImpl = makeConsole();
  let poisoned = false;

  const code = await runRemoteCp([`ubuntu:${source}`, destination], {
    config,
    console: consoleImpl,
    sleep: async () => {},
    fetch: async (url, init) => {
      const response = await backend.fetch(url, init);
      // Splice in the right *number* of bytes but the wrong content, so only
      // the final whole-file hash can catch it.
      if (!poisoned && response.status === 200 && response.body) {
        poisoned = true;
        return { ...response, body: Readable.toWeb(Readable.from([Buffer.alloc(200, 0xff)])) };
      }
      return response;
    },
  });

  assert.equal(code, 255);
  assert.ok(
    consoleImpl.errors.some((line) => line.includes("checksum mismatch")),
    consoleImpl.errors.join(" | "),
  );
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(`${destination}.${process.pid}.part`), false);

  await fsp.rm(root, { recursive: true, force: true });
});

test("retries are bounded rather than looping forever", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const source = path.join(localDir, "doomed.bin");
  await fsp.writeFile(source, Buffer.alloc(200, 1));

  let attempts = 0;
  const consoleImpl = makeConsole();
  const code = await runRemoteCp([source, `ubuntu:${path.join(remoteDir, "x.bin")}`], {
    config,
    console: consoleImpl,
    env: TINY_CHUNK,
    sleep: async () => {},
    fetch: async (url, init) => {
      if (init?.headers?.["Content-Range"]) {
        attempts += 1;
        throw new Error("network is down");
      }
      return backend.fetch(url, init);
    },
  });

  assert.equal(code, 255);
  assert.ok(attempts > 1, "should have retried at least once");
  assert.ok(attempts <= 8, `gave up in bounded time, took ${attempts} attempts`);

  await fsp.rm(root, { recursive: true, force: true });
});

test("a permanent error is not retried", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const source = path.join(localDir, "toobig.bin");
  await fsp.writeFile(source, Buffer.alloc(200, 1));

  let attempts = 0;
  const code = await runRemoteCp([source, `ubuntu:${path.join(remoteDir, "x.bin")}`], {
    config,
    console: makeConsole(),
    env: TINY_CHUNK,
    sleep: async () => {},
    fetch: async (url, init) => {
      if (init?.headers?.["Content-Range"]) {
        attempts += 1;
        return { ok: false, status: 413, body: null, text: async () => '{"error":"file too large"}' };
      }
      return backend.fetch(url, init);
    },
  });

  assert.equal(code, 255);
  assert.equal(attempts, 1, "413 is permanent; retrying it just wastes the user's time");

  await fsp.rm(root, { recursive: true, force: true });
});


test("an empty file transfers without a malformed Content-Range", async () => {
  const { root, localDir, remoteDir, backend } = await setup();
  const source = path.join(localDir, "empty.bin");
  await fsp.writeFile(source, "");

  const ranges = [];
  const target = path.join(remoteDir, "empty.bin");
  const code = await runRemoteCp([source, `ubuntu:${target}`], {
    config,
    console: makeConsole(),
    env: TINY_CHUNK,
    fetch: async (url, init) => {
      if (init?.headers?.["Content-Range"]) ranges.push(init.headers["Content-Range"]);
      return backend.fetch(url, init);
    },
  });

  assert.equal(code, 0);
  assert.equal((await fsp.stat(target)).size, 0);
  // `bytes 0-0/0` would claim one byte of a zero-byte file.
  assert.deepEqual(ranges, [], "an empty body needs no range at all");

  await fsp.rm(root, { recursive: true, force: true });
});
