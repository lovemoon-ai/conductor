import { promises as fsp } from "node:fs";
import path from "node:path";

import {
  buildResumeContext,
  isExistingDirectory,
  iterateJsonlEntries,
  normalizeSessionId,
  resolveHomeDir,
  resolveSessionRunDirectory,
} from "./shared.js";

export const BACKEND = "codex";

export function buildCliArgs(sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return [];
  }
  return ["resume", normalizedSessionId];
}

export async function findSessionPath(sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return null;
  }
  const homeDir = resolveHomeDir(options);
  const sessionsDir = options.codexSessionsDir || path.join(homeDir, ".codex", "sessions");
  return findCodexSessionFile(sessionsDir, normalizedSessionId);
}

export async function extractResumeCwd(sessionPath) {
  if (!sessionPath || !sessionPath.endsWith(".jsonl")) {
    return null;
  }
  for await (const entry of iterateJsonlEntries(sessionPath)) {
    const maybeCwd = entry?.type === "session_meta" ? entry?.payload?.cwd : null;
    if (typeof maybeCwd === "string" && maybeCwd.trim()) {
      return maybeCwd.trim();
    }
  }
  return null;
}

export async function resolveResumeContext(sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error("--resume requires a session id");
  }
  const sessionPath = await findSessionPath(normalizedSessionId, options);
  if (!sessionPath) {
    throw new Error(`Invalid --resume session id for codex: ${normalizedSessionId}`);
  }
  const cwdFromSession = await extractResumeCwd(sessionPath);
  const fallbackCwd = await resolveSessionRunDirectory(sessionPath);
  const cwd = cwdFromSession || fallbackCwd;
  if (!cwd) {
    throw new Error(`Could not resolve workspace for codex session ${normalizedSessionId}`);
  }
  if (!(await isExistingDirectory(cwd))) {
    throw new Error(`Resume workspace path does not exist: ${cwd}`);
  }
  return buildResumeContext({
    provider: "codex",
    sessionId: normalizedSessionId,
    sessionPath,
    cwd,
    cwdSource: cwdFromSession ? "session" : "session_path",
  });
}

async function findCodexSessionFile(rootDir, sessionId) {
  const queue = [rootDir];
  while (queue.length) {
    const current = queue.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile() && entry.name.includes(sessionId) && entry.name.endsWith(".jsonl")) {
        return fullPath;
      }
    }
  }
  return null;
}
