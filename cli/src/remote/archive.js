/**
 * Directory transfer, built on the single-file path plus `tar`.
 *
 * `remote cp -r` packs a directory locally (or remotely), moves the one
 * resulting tarball through the ordinary transfer, then unpacks it on the other
 * side. No new protocol: the wire still only ever carries one file.
 *
 * The remote halves run through `sh -c` with the paths passed as **positional
 * arguments**, never interpolated into the script text. A directory literally
 * named `; rm -rf /` is therefore just an awkward directory name.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Where the target stages its tarball. Overridable for hosts without /tmp. */
export function remoteTempPath(env = process.env) {
  const root = (env.CONDUCTOR_REMOTE_TMP || "/tmp").replace(/\/+$/, "") || "/tmp";
  return `${root}/.conductor-rcp-${randomUUID()}.tgz`;
}

export function localTempPath() {
  return path.join(os.tmpdir(), `.conductor-rcp-${randomUUID()}.tgz`);
}

/**
 * Unpack `$1` into `$2`, following scp: an existing destination directory
 * receives the source *inside* it; a missing one becomes the copy itself.
 * `$3` is the source's basename, which is the top-level entry in the tarball.
 */
export const EXTRACT_SCRIPT = `
set -e
tmp=$1; dest=$2; base=$3
if [ -d "$dest" ]; then
  tar xzf "$tmp" -C "$dest"
else
  parent=$(dirname "$dest")
  mkdir -p "$parent"
  # Unpack into a private staging dir, never straight into the parent: the
  # tarball's top entry is the SOURCE's name, and an unrelated neighbour of
  # the destination could already have it. Extracting in place would clobber
  # that neighbour, and the rename below would then carry it off.
  # Staging inside the parent keeps the final mv on one filesystem.
  stage=$(mktemp -d "$parent/.conductor-rcp-XXXXXX")
  tar xzf "$tmp" -C "$stage"
  rm -rf "$dest"
  mv "$stage/$base" "$dest"
  rmdir "$stage"
fi
`.trim();

/** Pack directory `$1` into tarball `$2`, keeping `$1`'s own name inside. */
export const PACK_SCRIPT = `
set -e
src=$1; tmp=$2
if [ ! -d "$src" ]; then
  echo "not a directory: $src" >&2
  exit 1
fi
tar czf "$tmp" -C "$(dirname "$src")" "$(basename "$src")"
`.trim();

/** Remove the staged tarball. Never fails the transfer. */
export const CLEANUP_SCRIPT = 'rm -f "$1"';

/** `sh -c <script> sh <args...>` — the `sh` placeholder becomes $0. */
export function shellArgs(script, ...args) {
  return ["-c", script, "sh", ...args];
}

function runLocal(command, args, { spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      // Bounded: a pathological tar could otherwise stream forever.
      if (stderr.length < 8192) stderr += String(chunk);
    });
    child.on("error", (error) =>
      reject(new Error(`failed to run ${command}: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

/** Pack a local directory, preserving its own name as the top-level entry. */
export async function packLocalDirectory(sourceDir, tarball, deps = {}) {
  await runLocal(
    "tar",
    ["czf", tarball, "-C", path.dirname(sourceDir), path.basename(sourceDir)],
    deps,
  );
  return tarball;
}

/** Unpack locally with the same scp semantics as `EXTRACT_SCRIPT`. */
export async function unpackLocalDirectory(tarball, destination, baseName, deps = {}) {
  const fsp = deps.fsp || fs.promises;
  let destStat = null;
  try {
    destStat = await fsp.stat(destination);
  } catch {
    destStat = null;
  }

  if (destStat?.isDirectory()) {
    await runLocal("tar", ["xzf", tarball, "-C", destination], deps);
    return path.join(destination, baseName);
  }

  const parent = path.dirname(destination);
  await fsp.mkdir(parent, { recursive: true });
  // Same reasoning as EXTRACT_SCRIPT: stage in a private directory so an
  // existing neighbour that happens to share the source's name survives.
  const stage = await fsp.mkdtemp(path.join(parent, ".conductor-rcp-"));
  try {
    await runLocal("tar", ["xzf", tarball, "-C", stage], deps);
    await fsp.rm(destination, { recursive: true, force: true });
    await fsp.rename(path.join(stage, baseName), destination);
  } finally {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
  return destination;
}
