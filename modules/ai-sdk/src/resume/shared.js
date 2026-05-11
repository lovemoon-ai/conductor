import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export function normalizeBackend(backend) {
  return String(backend || "").trim().toLowerCase();
}

export function normalizeSessionId(sessionId) {
  return typeof sessionId === "string" ? sessionId.trim() : "";
}

export function resolveHomeDir(options) {
  if (options?.homeDir) {
    return options.homeDir;
  }
  return os.homedir();
}

export function normalizeProjectPathCandidate(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export async function pathExists(targetPath, expectedType) {
  try {
    const stats = await fsp.stat(targetPath);
    if (expectedType === "file") {
      return stats.isFile();
    }
    if (expectedType === "directory") {
      return stats.isDirectory();
    }
    return true;
  } catch {
    return false;
  }
}

export async function isExistingDirectory(targetPath) {
  const normalizedPath = typeof targetPath === "string" ? targetPath.trim() : "";
  if (!normalizedPath) {
    return false;
  }
  try {
    const stats = await fsp.stat(normalizedPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

export async function resolveSessionRunDirectory(sessionPath) {
  const normalizedPath = typeof sessionPath === "string" ? sessionPath.trim() : "";
  if (!normalizedPath) {
    throw new Error("Invalid session path");
  }
  let stats;
  try {
    stats = await fsp.stat(normalizedPath);
  } catch {
    throw new Error(`Session path does not exist: ${normalizedPath}`);
  }
  return stats.isDirectory() ? normalizedPath : path.dirname(normalizedPath);
}

export function listCandidateWorkingDirectories(options = {}) {
  const candidates = [];
  const push = (value) => {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
      return;
    }
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  push(options.cwd);
  push(options.currentWorkingDirectory);
  push(process.env.PWD);
  push(process.cwd());

  return candidates;
}

export async function* iterateJsonlEntries(sessionPath) {
  if (!sessionPath || !sessionPath.endsWith(".jsonl")) {
    return;
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(sessionPath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    yield entry;
  }
}

export function buildResumeContext({
  provider,
  sessionId,
  sessionPath = null,
  cwd,
  cwdSource,
  extraDebug = {},
}) {
  return {
    provider,
    sessionId,
    sessionPath: sessionPath || null,
    cwd,
    debugMetadata: {
      cwdSource,
      sessionPath: sessionPath || null,
      ...extraDebug,
    },
  };
}
