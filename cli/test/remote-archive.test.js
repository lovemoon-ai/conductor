import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import {
  CLEANUP_SCRIPT,
  EXTRACT_SCRIPT,
  PACK_SCRIPT,
  localTempPath,
  packLocalDirectory,
  remoteTempPath,
  shellArgs,
  unpackLocalDirectory,
} from "../src/remote/archive.js";

const makeTempDir = () => fsp.mkdtemp(path.join(os.tmpdir(), "conductor-archive-"));

test("shellArgs passes values positionally, never inside the script", () => {
  const args = shellArgs(EXTRACT_SCRIPT, "/tmp/t.tgz", "/srv; rm -rf /", "dist");
  assert.equal(args[0], "-c");
  assert.equal(args[1], EXTRACT_SCRIPT);
  // `sh` occupies $0 so the caller's values line up with $1, $2, $3.
  assert.equal(args[2], "sh");
  assert.deepEqual(args.slice(3), ["/tmp/t.tgz", "/srv; rm -rf /", "dist"]);
  assert.ok(!args[1].includes("rm -rf /"), "a hostile path must not reach the script text");
});

test("the remote scripts only ever reference positional parameters", () => {
  for (const script of [EXTRACT_SCRIPT, PACK_SCRIPT, CLEANUP_SCRIPT]) {
    // A `${...}` would mean something was interpolated at build time, which is
    // exactly the injection this design avoids.
    assert.ok(!script.includes("${"), `unexpected interpolation in: ${script}`);
  }
});

test("remoteTempPath honours CONDUCTOR_REMOTE_TMP and is unique", () => {
  const a = remoteTempPath({});
  assert.match(a, /^\/tmp\/\.conductor-rcp-[0-9a-f-]+\.tgz$/);
  assert.notEqual(a, remoteTempPath({}));
  assert.match(remoteTempPath({ CONDUCTOR_REMOTE_TMP: "/var/tmp/" }), /^\/var\/tmp\/\.conductor-rcp-/);
});

test("localTempPath lands in the OS temp dir and is unique", () => {
  const a = localTempPath();
  assert.equal(path.dirname(a), os.tmpdir());
  assert.notEqual(a, localTempPath());
});

test("packLocalDirectory keeps the directory's own name as the top entry", async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "payload");
  await fsp.mkdir(path.join(source, "sub"), { recursive: true });
  await fsp.writeFile(path.join(source, "sub", "f.txt"), "x");

  const tarball = path.join(dir, "out.tgz");
  await packLocalDirectory(source, tarball);
  assert.ok((await fsp.stat(tarball)).size > 0);

  const into = path.join(dir, "into");
  await fsp.mkdir(into);
  const landed = await unpackLocalDirectory(tarball, into, "payload");
  assert.equal(landed, path.join(into, "payload"));
  assert.equal(await fsp.readFile(path.join(into, "payload", "sub", "f.txt"), "utf8"), "x");

  await fsp.rm(dir, { recursive: true, force: true });
});

test("unpackLocalDirectory renames onto a destination that does not exist yet", async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "payload");
  await fsp.mkdir(source, { recursive: true });
  await fsp.writeFile(path.join(source, "f.txt"), "y");
  const tarball = path.join(dir, "out.tgz");
  await packLocalDirectory(source, tarball);

  // scp semantics: a missing destination becomes the copy itself.
  const destination = path.join(dir, "renamed");
  const landed = await unpackLocalDirectory(tarball, destination, "payload");
  assert.equal(landed, destination);
  assert.equal(await fsp.readFile(path.join(destination, "f.txt"), "utf8"), "y");
  assert.equal(fs.existsSync(path.join(dir, "payload", "f.txt")), true, "source untouched");

  await fsp.rm(dir, { recursive: true, force: true });
});

test("unpackLocalDirectory creates missing parents", async () => {
  const dir = await makeTempDir();
  const source = path.join(dir, "payload");
  await fsp.mkdir(source, { recursive: true });
  await fsp.writeFile(path.join(source, "f.txt"), "z");
  const tarball = path.join(dir, "out.tgz");
  await packLocalDirectory(source, tarball);

  const destination = path.join(dir, "a", "b", "c");
  await unpackLocalDirectory(tarball, destination, "payload");
  assert.equal(await fsp.readFile(path.join(destination, "f.txt"), "utf8"), "z");

  await fsp.rm(dir, { recursive: true, force: true });
});

test("packLocalDirectory surfaces tar's own error", async () => {
  const dir = await makeTempDir();
  await assert.rejects(
    () => packLocalDirectory(path.join(dir, "missing"), path.join(dir, "o.tgz")),
    /tar exited/,
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

test("packLocalDirectory reports a missing tar binary clearly", async () => {
  const dir = await makeTempDir();
  await assert.rejects(
    () => packLocalDirectory(dir, path.join(dir, "o.tgz"), {
      spawnFn: () => {
        const fake = new EventEmitter();
        process.nextTick(() => fake.emit("error", new Error("spawn tar ENOENT")));
        return fake;
      },
    }),
    /failed to run tar/,
  );
  await fsp.rm(dir, { recursive: true, force: true });
});
