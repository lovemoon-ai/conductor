import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import {
  buildResumeContext,
  isExistingDirectory,
  listCandidateWorkingDirectories,
  normalizeSessionId,
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

  const homeDir = resolveHomeDir(options);
  const sessionsDir = options.kimiSessionsDir || path.join(homeDir, ".kimi", "sessions");
  return findKimiSessionDirectory(sessionsDir, normalizedSessionId);
}

export async function resolveResumeContext(sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error("--resume requires a session id");
  }
  const sessionPath = await findSessionPath(normalizedSessionId, options);
  if (!sessionPath) {
    throw new Error(`Invalid --resume session id for kimi: ${normalizedSessionId}`);
  }
  const cwdFromSession = await resolveKimiResumeCwd(sessionPath, normalizedSessionId, options);
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

async function resolveKimiResumeCwd(sessionPath, _sessionId, options = {}) {
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
