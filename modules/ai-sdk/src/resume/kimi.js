import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import {
  buildResumeContext,
  isExistingDirectory,
  listCandidateWorkingDirectories,
  normalizeSessionId,
  normalizeSessionTitle,
  pathExists,
  resolveHomeDir,
} from "./shared.js";

export const BACKEND = "kimi";

export function buildCliArgs(sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return [];
  }
  return ["--session", normalizedSessionId];
}

export async function findSessionPath(sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return null;
  }
  const target = await findKimiSessionTarget(normalizedSessionId, options);
  return target?.sessionPath || null;
}

export async function resolveResumeContext(sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error("--resume requires a session id");
  }
  const target = await findKimiSessionTarget(normalizedSessionId, options);
  if (!target?.sessionPath) {
    throw new Error(`Invalid --resume session id for kimi: ${normalizedSessionId}`);
  }
  const sessionPath = target.sessionPath;
  const cwdFromSession =
    target.cwd || (await resolveLegacyKimiResumeCwd(sessionPath, normalizedSessionId, options));
  if (!cwdFromSession) {
    throw new Error(
      `Could not resolve workspace for Kimi session ${normalizedSessionId}. Re-run from the original workspace or resume a session previously started by conductor fire.`,
    );
  }
  if (!(await isExistingDirectory(cwdFromSession))) {
    throw new Error(`Resume workspace path does not exist: ${cwdFromSession}`);
  }
  return buildResumeContext({
    provider: "kimi",
    sessionId: normalizedSessionId,
    sessionPath,
    cwd: cwdFromSession,
    cwdSource: "session",
  });
}

export function md5Hex(value) {
  return crypto.createHash("md5").update(String(value ?? "")).digest("hex");
}

async function resolveLegacyKimiResumeCwd(sessionPath, _sessionId, options = {}) {
  const sessionDirectory = typeof sessionPath === "string" ? sessionPath.trim() : "";
  if (!sessionDirectory) {
    return null;
  }

  const worktreeHash = path.basename(path.dirname(sessionDirectory));
  if (!worktreeHash) {
    return null;
  }

  for (const candidate of listCandidateWorkingDirectories(options)) {
    if (md5Hex(candidate) === worktreeHash) {
      return candidate;
    }
  }

  if (typeof options.lookupWorkspaceByHash === "function") {
    const resolved = await options.lookupWorkspaceByHash(worktreeHash, { sessionId: _sessionId });
    if (typeof resolved === "string" && resolved.trim()) {
      return resolved.trim();
    }
  }

  return null;
}

/**
 * Lists local Kimi Code sessions, newest first.
 *
 * Prefers the session_index.jsonl fast path and falls back to scanning
 * `<KIMI_CODE_HOME>/sessions/<hash>/<sessionId>/`. Candidates are ranked by
 * directory mtime; state.json is only read for the `limit` newest sessions.
 */
export async function listSessions(options = {}) {
  const { limit = 20 } = options;
  const homeDir = resolveHomeDir(options);
  const kimiCodeHome = resolveKimiCodeHome(homeDir, options);
  const sessionsDir = path.join(kimiCodeHome, "sessions");

  let stated = await statKimiSessionCandidates(
    await listIndexedKimiCodeSessions(kimiCodeHome, sessionsDir),
  );
  if (!stated.length) {
    // The index can go stale wholesale (sessions dir cleaned, index copied from
    // another machine), so fall back to scanning even when it had records.
    stated = await statKimiSessionCandidates(await scanKimiCodeSessionDirs(sessionsDir));
  }
  stated.sort((a, b) => b.updatedAt - a.updatedAt);

  const sessions = [];
  for (const candidate of stated.slice(0, Math.max(0, limit))) {
    const statePath = path.join(candidate.sessionPath, "state.json");
    let state = null;
    try {
      state = JSON.parse(await fsp.readFile(statePath, "utf8"));
    } catch {
      // Fall back to the session index record, which also carries workDir.
    }
    const stateWorkDir = typeof state?.workDir === "string" ? state.workDir.trim() : "";
    // The Kimi Code message log format is not stable; use the title recorded in
    // state.json / the session index when present instead of parsing messages.
    const title =
      normalizeSessionTitle(state?.title) || normalizeSessionTitle(candidate.title) || null;
    sessions.push({
      sessionId: candidate.sessionId,
      sessionFilePath: (await pathExists(statePath, "file")) ? statePath : null,
      cwd: stateWorkDir || candidate.workDir || null,
      title,
      updatedAt: candidate.updatedAt,
    });
  }
  return sessions;
}

async function statKimiSessionCandidates(candidates) {
  const stated = [];
  for (const candidate of candidates) {
    let stats;
    try {
      stats = await fsp.stat(candidate.sessionPath);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) {
      continue;
    }
    stated.push({ ...candidate, updatedAt: Math.round(stats.mtimeMs) });
  }
  return stated;
}

async function listIndexedKimiCodeSessions(kimiCodeHome, sessionsDir) {
  let raw = "";
  try {
    raw = await fsp.readFile(path.join(kimiCodeHome, "session_index.jsonl"), "utf8");
  } catch {
    return [];
  }

  const recordsBySessionId = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let record = null;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const sessionId = typeof record?.sessionId === "string" ? record.sessionId.trim() : "";
    if (!sessionId) {
      continue;
    }
    if (record?.deleted === true) {
      recordsBySessionId.delete(sessionId);
      continue;
    }
    const sessionDir = typeof record?.sessionDir === "string" ? record.sessionDir.trim() : "";
    if (!sessionDir || !path.isAbsolute(sessionDir)) {
      continue;
    }
    const relativePath = path.relative(path.resolve(sessionsDir), path.resolve(sessionDir));
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath) ||
      path.basename(sessionDir) !== sessionId
    ) {
      continue;
    }
    recordsBySessionId.set(sessionId, {
      sessionId,
      sessionPath: sessionDir,
      workDir: typeof record?.workDir === "string" && record.workDir.trim() ? record.workDir.trim() : null,
      title: typeof record?.title === "string" ? record.title : null,
    });
  }
  return [...recordsBySessionId.values()];
}

async function scanKimiCodeSessionDirs(sessionsDir) {
  let hashDirs = [];
  try {
    hashDirs = await fsp.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = [];
  for (const hashDir of hashDirs) {
    if (!hashDir.isDirectory()) {
      continue;
    }
    let sessionDirs = [];
    try {
      sessionDirs = await fsp.readdir(path.join(sessionsDir, hashDir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) {
        continue;
      }
      candidates.push({
        sessionId: sessionDir.name,
        sessionPath: path.join(sessionsDir, hashDir.name, sessionDir.name),
        workDir: null,
        title: null,
      });
    }
  }
  return candidates;
}

async function findKimiSessionTarget(sessionId, options = {}) {
  const homeDir = resolveHomeDir(options);
  const kimiCodeHome = resolveKimiCodeHome(homeDir, options);
  const kimiCodeTarget = await findKimiCodeSession(kimiCodeHome, sessionId);
  if (kimiCodeTarget) {
    return kimiCodeTarget;
  }

  const legacySessionsDir = options.kimiSessionsDir || path.join(homeDir, ".kimi", "sessions");
  const legacySessionPath = await findKimiSessionDirectory(legacySessionsDir, sessionId);
  return legacySessionPath
    ? {
        sessionPath: legacySessionPath,
        cwd: null,
      }
    : null;
}

function resolveKimiCodeHome(homeDir, options = {}) {
  const configured =
    options.kimiCodeHome ||
    options.env?.KIMI_CODE_HOME ||
    (!options.homeDir ? process.env.KIMI_CODE_HOME : "");
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : path.join(homeDir, ".kimi-code");
}

async function findKimiCodeSession(kimiCodeHome, sessionId) {
  const sessionsDir = path.join(kimiCodeHome, "sessions");
  const indexed = await findIndexedKimiCodeSession(kimiCodeHome, sessionsDir, sessionId);
  if (indexed) {
    return indexed;
  }

  const sessionPath = await findKimiSessionDirectory(sessionsDir, sessionId);
  if (!sessionPath) {
    return null;
  }
  return {
    sessionPath,
    cwd: await readKimiCodeSessionWorkDir(sessionPath),
  };
}

async function findIndexedKimiCodeSession(kimiCodeHome, sessionsDir, sessionId) {
  let raw = "";
  try {
    raw = await fsp.readFile(path.join(kimiCodeHome, "session_index.jsonl"), "utf8");
  } catch {
    return null;
  }

  let matched = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let record = null;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (record?.sessionId !== sessionId) {
      continue;
    }
    if (record?.deleted === true) {
      matched = null;
      continue;
    }
    const sessionDir = typeof record?.sessionDir === "string" ? record.sessionDir.trim() : "";
    if (!sessionDir || !path.isAbsolute(sessionDir)) {
      continue;
    }
    const relativePath = path.relative(path.resolve(sessionsDir), path.resolve(sessionDir));
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath) ||
      path.basename(sessionDir) !== sessionId
    ) {
      continue;
    }
    matched = {
      sessionPath: sessionDir,
      cwd: typeof record?.workDir === "string" ? record.workDir.trim() : "",
    };
  }

  if (!matched || !(await pathExists(matched.sessionPath, "directory"))) {
    return null;
  }
  return {
    sessionPath: matched.sessionPath,
    cwd: await readKimiCodeSessionWorkDir(matched.sessionPath, matched.cwd),
  };
}

async function readKimiCodeSessionWorkDir(sessionPath, fallback = "") {
  try {
    const raw = await fsp.readFile(path.join(sessionPath, "state.json"), "utf8");
    const state = JSON.parse(raw);
    if (typeof state?.workDir === "string" && state.workDir.trim()) {
      return state.workDir.trim();
    }
  } catch {
    // Fall back to the session index, which also records the working directory.
  }
  return typeof fallback === "string" && fallback.trim() ? fallback.trim() : null;
}

async function findKimiSessionDirectory(rootDir, sessionId) {
  let hashDirs = [];
  try {
    hashDirs = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const hashDir of hashDirs) {
    if (!hashDir.isDirectory()) {
      continue;
    }
    const candidateDir = path.join(rootDir, hashDir.name, sessionId);
    if (await pathExists(candidateDir, "directory")) {
      return candidateDir;
    }
  }
  return null;
}
