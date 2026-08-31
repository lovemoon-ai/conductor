import fs from "node:fs";
import path from "node:path";

// On-disk hand-off records that let a *fresh* daemon adopt the tmux Fire
// sessions its predecessor deliberately left running.
//
// In `fire_tmux_mode` daemon shutdown intentionally keeps Fires alive
// ("Daemon shutting down: leaving tmux-detached Fire task … running"), but
// everything the liveness reaper needs to classify their eventual exit —
// `logPath`, `logStartOffset`, `exitMarkerToken`, `spawnedAtMs` — lived only
// in the old process's memory. `exitMarkerToken` in particular is a
// per-spawn random nonce that cannot be recomputed, so without persisting it
// a successor daemon can never read the exit marker the predecessor's
// wrapper shell writes, and an adopted task could only ever be reported as
// "died hard". These files close that gap.
//
// Records are keyed by tmux session name because that is the only identifier
// a successor can enumerate (`tmux list-sessions`). The task id is NOT
// recoverable from a session name: `buildFireTmuxSessionPrefix` truncates it
// to 32 characters, which is shorter than a UUID.

export const FIRE_SESSION_RECORD_VERSION = 1;

export function resolveFireSessionRegistryDir(conductorHome) {
  return path.join(String(conductorHome || ""), "daemon", "fire-sessions");
}

// Session names are built from a sanitized task id plus a base36 nonce, so in
// practice they are already `[A-Za-z0-9_-]+`. Re-check anyway: this value
// decides a filename, and a name carrying `/` or `..` would let a crafted
// tmux session read or delete files outside the registry directory.
function isSafeSessionName(sessionName) {
  return typeof sessionName === "string" && /^[A-Za-z0-9_-]+$/.test(sessionName);
}

function recordPath(dir, sessionName) {
  return path.join(dir, `${sessionName}.json`);
}

function normalizeRecord(record) {
  return {
    version: FIRE_SESSION_RECORD_VERSION,
    taskId: String(record?.taskId || ""),
    projectId: String(record?.projectId || ""),
    tmuxSession: String(record?.tmuxSession || ""),
    logPath: String(record?.logPath || ""),
    logStartOffset: Number(record?.logStartOffset) || 0,
    exitMarkerToken: String(record?.exitMarkerToken || ""),
    spawnedAtMs: Number(record?.spawnedAtMs) || 0,
    daemonName: String(record?.daemonName || ""),
  };
}

// Write is atomic (tmp + rename) so a daemon killed mid-write cannot leave a
// truncated record that the successor would parse as "no metadata".
export function writeFireSessionRecord(dir, record, { fsImpl = fs } = {}) {
  const normalized = normalizeRecord(record);
  if (!normalized.tmuxSession || !normalized.taskId) return false;
  if (!isSafeSessionName(normalized.tmuxSession)) return false;
  fsImpl.mkdirSync(dir, { recursive: true });
  const finalPath = recordPath(dir, normalized.tmuxSession);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmpPath, `${JSON.stringify(normalized)}\n`, "utf8");
  fsImpl.renameSync(tmpPath, finalPath);
  return true;
}

// Returns `null` for anything we cannot fully trust: missing file, unparsable
// JSON, unknown version, or a record whose own `tmuxSession` disagrees with
// the name it was filed under. Callers treat `null` as "adopt in degraded
// mode", never as "the session is dead".
export function readFireSessionRecord(dir, sessionName, { fsImpl = fs } = {}) {
  if (!isSafeSessionName(sessionName)) return null;
  let raw;
  try {
    raw = fsImpl.readFileSync(recordPath(dir, sessionName), "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (Number(parsed.version) !== FIRE_SESSION_RECORD_VERSION) return null;
  if (String(parsed.tmuxSession || "") !== sessionName) return null;
  if (!parsed.taskId) return null;
  return normalizeRecord(parsed);
}

export function deleteFireSessionRecord(dir, sessionName, { fsImpl = fs } = {}) {
  if (!isSafeSessionName(sessionName)) return false;
  try {
    fsImpl.rmSync(recordPath(dir, sessionName), { force: true });
    return true;
  } catch {
    return false;
  }
}

// Drop records whose tmux session no longer exists. Without this the registry
// would grow one file per Fire ever spawned: the targeted deletes on the
// reap/stop/delete paths cover the common cases, but a daemon that is
// SIGKILLed leaves its records behind with nothing to remove them.
export function pruneFireSessionRecords(dir, liveSessionNames, { fsImpl = fs } = {}) {
  const live = new Set(Array.isArray(liveSessionNames) ? liveSessionNames : []);
  let entries;
  try {
    entries = fsImpl.readdirSync(dir);
  } catch {
    return 0;
  }
  let pruned = 0;
  for (const entry of entries) {
    // A `.tmp` file only exists between writeFileSync and renameSync, so one
    // that survives to a prune is debris from a crashed write.
    if (entry.endsWith(".tmp")) {
      try {
        fsImpl.rmSync(path.join(dir, entry), { force: true });
        pruned += 1;
      } catch {
        // best effort
      }
      continue;
    }
    if (!entry.endsWith(".json")) continue;
    const sessionName = entry.slice(0, -".json".length);
    if (live.has(sessionName)) continue;
    if (deleteFireSessionRecord(dir, sessionName, { fsImpl })) {
      pruned += 1;
    }
  }
  return pruned;
}
