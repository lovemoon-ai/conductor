import crypto from "node:crypto";
import path from "node:path";

// Shared reader/writer for `${WORKSPACE_ROOT}/daemon.pid`.
//
// The lock file is read by two independent code paths that must agree:
//   - `src/daemon.js` (in-process lock acquisition, including `--force`)
//   - `bin/conductor-daemon.js` (the `--nohup` preflight)
// Keeping the parse/serialize/compare logic here is what stops them drifting.
export const DAEMON_LOCK_FILE_NAME = "daemon.pid";

// Opt-in escape hatch for the legacy-lock case documented on
// `compareDaemonLockIdentity` below.
export const FORCE_KILL_UNKNOWN_OWNER_ENV_VAR = "CONDUCTOR_DAEMON_FORCE_KILL_UNKNOWN";

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizePositiveInt(value, fallback = null) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePathField(value) {
  const normalized = normalizeOptionalString(value);
  return normalized ? path.resolve(normalized) : "";
}

/**
 * The instance fingerprint deliberately covers only the three *path* axes that
 * define a Conductor instance (see RFC 0036): where its config lives, where its
 * state lives, and where its workspace lives. Two daemons that differ on any of
 * these are separate instances and must never force-kill each other.
 *
 * `daemon_name` and `backend_url` are recorded alongside it but intentionally
 * left OUT of the hash: both are mutable config *contents* that a user
 * legitimately edits between restarts (rename the daemon, point it at a
 * different backend), and hashing them would turn "restart my own daemon after
 * a config edit" into a refusal.
 */
export function computeDaemonInstanceId({ conductorHome, configPath, workspaceRoot }) {
  const parts = [
    normalizePathField(conductorHome),
    normalizePathField(configPath),
    normalizePathField(workspaceRoot),
  ];
  if (!parts.some(Boolean)) {
    return "";
  }
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

export function buildDaemonInstanceIdentity({
  conductorHome,
  configPath,
  workspaceRoot,
  daemonName,
  backendUrl,
} = {}) {
  const normalized = {
    conductorHome: normalizePathField(conductorHome),
    configPath: normalizePathField(configPath),
    workspaceRoot: normalizePathField(workspaceRoot),
  };
  return {
    ...normalized,
    instanceId: computeDaemonInstanceId(normalized),
    daemonName: normalizeOptionalString(daemonName),
    backendUrl: normalizeOptionalString(backendUrl),
  };
}

/**
 * Accepts both the legacy bare-pid file written by CLIs older than the identity
 * change and the JSON payload written by `serializeDaemonLock`.
 * Returns `null` for empty/malformed content.
 */
export function parseDaemonLockState(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return null;
  }

  const barePid = normalizePositiveInt(text);
  if (barePid !== null && String(barePid) === text) {
    return {
      pid: barePid,
      instanceId: "",
      conductorHome: "",
      configPath: "",
      workspaceRoot: "",
      daemonName: "",
      backendUrl: "",
      handoffFromPid: null,
      handoffToken: null,
      handoffExpiresAt: null,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const handoffFromPid = normalizePositiveInt(parsed.handoff_from_pid);
  return {
    pid: normalizePositiveInt(parsed.pid) ?? handoffFromPid,
    instanceId: normalizeOptionalString(parsed.instance_id),
    conductorHome: normalizeOptionalString(parsed.conductor_home),
    configPath: normalizeOptionalString(parsed.config_path),
    workspaceRoot: normalizeOptionalString(parsed.workspace_root),
    daemonName: normalizeOptionalString(parsed.daemon_name),
    backendUrl: normalizeOptionalString(parsed.backend_url),
    handoffFromPid,
    handoffToken: normalizeOptionalString(parsed.handoff_token) || null,
    handoffExpiresAt: normalizePositiveInt(parsed.handoff_expires_at),
  };
}

/**
 * Single writer for the lock file. `handoff` is the auto-update takeover
 * payload; when present the recorded pid is the *outgoing* daemon's pid, which
 * is exactly what the pre-existing handoff protocol expects.
 */
export function serializeDaemonLock({ pid, identity, handoff } = {}) {
  const payload = {
    pid: normalizePositiveInt(pid),
    instance_id: identity?.instanceId || "",
    daemon_name: identity?.daemonName || "",
    config_path: identity?.configPath || "",
    conductor_home: identity?.conductorHome || "",
    workspace_root: identity?.workspaceRoot || "",
    backend_url: identity?.backendUrl || "",
  };
  if (handoff) {
    payload.handoff_from_pid = normalizePositiveInt(handoff.handoffFromPid);
    payload.handoff_token = handoff.handoffToken || null;
    payload.handoff_expires_at = normalizePositiveInt(handoff.handoffExpiresAt);
  }
  return JSON.stringify(payload);
}

/**
 * Ownership verdict for a lock file relative to the instance about to act on it.
 *
 *   "self"    — the lock records our instance fingerprint; force-restart is ours to do.
 *   "other"   — the lock records a *different* instance; never kill it.
 *   "unknown" — legacy lock with no identity field (written by an older CLI), or
 *               we could not fingerprint ourselves.
 *
 * On "unknown" callers must refuse by default. There is no way to interrogate a
 * running process for its Conductor identity from the outside: macOS does not
 * expose another process's environment (`ps -E`/`ps eww` print argv only, even
 * for processes you own), and the daemon's instance is selected mostly by env
 * vars, so argv tells us nothing either. Since we cannot obtain a positive
 * same-instance signal, guessing "it's probably mine" is exactly the
 * cross-account kill primitive this check exists to remove.
 *
 * The legitimate "restart my own daemon after upgrading the CLI" flow is not
 * hard-broken by that refusal:
 *   - Auto-update restarts go through the handoff token, which *is* a verifiable
 *     positive signal (a secret the outgoing daemon hands to its own successor)
 *     and is checked before ownership; legacy handoff locks keep working.
 *   - A stale legacy lock (dead pid) is still cleaned up silently.
 *   - A live legacy lock only needs a one-time manual `kill <pid>` or an explicit
 *     `CONDUCTOR_DAEMON_FORCE_KILL_UNKNOWN=1`, after which every subsequent lock
 *     carries an identity and `--force` works normally again.
 */
export function compareDaemonLockIdentity(lockState, identity) {
  const lockInstanceId = normalizeOptionalString(lockState?.instanceId);
  const selfInstanceId = normalizeOptionalString(identity?.instanceId);
  if (!lockInstanceId || !selfInstanceId) {
    return "unknown";
  }
  return lockInstanceId === selfInstanceId ? "self" : "other";
}

export function isForceKillUnknownOwnerEnabled(env = process.env) {
  const value = normalizeOptionalString(env?.[FORCE_KILL_UNKNOWN_OWNER_ENV_VAR]).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function describeIdentityFields({ daemonName, configPath, workspaceRoot, backendUrl }) {
  const details = [];
  if (configPath) details.push(`config ${configPath}`);
  if (workspaceRoot) details.push(`workspace ${workspaceRoot}`);
  if (backendUrl) details.push(`backend ${backendUrl}`);
  const name = daemonName ? `daemon_name "${daemonName}"` : "an unnamed daemon";
  return details.length > 0 ? `${name} (${details.join(", ")})` : name;
}

export function describeDaemonLockOwner(lockState) {
  if (!lockState?.instanceId) {
    return "an unidentified daemon (lock file written by an older Conductor CLI)";
  }
  return describeIdentityFields(lockState);
}

export function describeDaemonInstance(identity) {
  return describeIdentityFields(identity || {});
}

/**
 * Single source of truth for whether `--force` may stop the process recorded in
 * the lock file. Returns null when the force restart may proceed, otherwise the
 * user-facing refusal reason.
 *
 * Both `src/daemon.js` and the `bin/conductor-daemon.js --nohup` preflight call
 * this so the two paths cannot disagree about who owns the lock.
 */
export function describeForceRestartRefusal({ lockState, identity, lockFile, env = process.env } = {}) {
  const ownership = compareDaemonLockIdentity(lockState, identity);
  if (ownership === "self") {
    return null;
  }
  const pid = lockState?.pid;
  const held = lockFile ? `${lockFile} is held by PID ${pid}` : `PID ${pid} holds the daemon lock`;
  if (ownership === "other") {
    return (
      `refusing --force: ${held}, which belongs to a different Conductor instance — ${describeDaemonLockOwner(lockState)}. ` +
      `This instance is ${describeDaemonInstance(identity)}. ` +
      `Give each instance its own CONDUCTOR_WS (and CONDUCTOR_HOME), or stop PID ${pid} yourself.`
    );
  }
  if (isForceKillUnknownOwnerEnabled(env)) {
    return null;
  }
  return (
    `refusing --force: ${held} but records no instance identity, so it cannot be confirmed to be this daemon. ` +
    `This instance is ${describeDaemonInstance(identity)}. ` +
    `If PID ${pid} is your own daemon from an older CLI, stop it with \`kill ${pid}\` or re-run with ` +
    `${FORCE_KILL_UNKNOWN_OWNER_ENV_VAR}=1 (one time only; the next lock file will carry an identity).`
  );
}
