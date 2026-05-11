import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import {
  buildResumeContext,
  isExistingDirectory,
  normalizeSessionId,
  pathExists,
  resolveHomeDir,
  resolveSessionRunDirectory,
} from "./shared.js";

export const BACKEND = "claude";

export function buildCliArgs(sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return [];
  }
  return ["--resume", normalizedSessionId];
}

export async function findSessionPath(sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  const homeDir = resolveHomeDir(options);
  const projectsDir = options.claudeProjectsDir || path.join(homeDir, ".claude", "projects");
  const sessionEntries = await findClaudeSessionEntries(projectsDir, normalizedSessionId);
  if (sessionEntries.length > 0) {
    return sessionEntries[0]?.source || null;
  }

  const tasksDir = options.claudeTasksDir || path.join(homeDir, ".claude", "tasks");
  const directTaskDir = path.join(tasksDir, normalizedSessionId);
  if (await pathExists(directTaskDir, "directory")) {
    return directTaskDir;
  }

  return null;
}

export async function extractResumeCwd(sessionPath, sessionId) {
  if (!sessionPath || !sessionPath.endsWith(".jsonl")) {
    return null;
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
    const idMatches = String(entry?.sessionId || "").trim() === sessionId;
    const maybeCwd = entry?.cwd;
    if (idMatches && typeof maybeCwd === "string" && maybeCwd.trim()) {
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
    throw new Error(`Invalid --resume session id for claude: ${normalizedSessionId}`);
  }
  const cwdFromSession = await extractResumeCwd(sessionPath, normalizedSessionId);
  const fallbackCwd = await resolveSessionRunDirectory(sessionPath);
  const cwd = cwdFromSession || fallbackCwd;
  if (!cwd) {
    throw new Error(`Could not resolve workspace for claude session ${normalizedSessionId}`);
  }
  if (!(await isExistingDirectory(cwd))) {
    throw new Error(`Resume workspace path does not exist: ${cwd}`);
  }
  return buildResumeContext({
    provider: "claude",
    sessionId: normalizedSessionId,
    sessionPath,
    cwd,
    cwdSource: cwdFromSession ? "session" : "session_path",
  });
}

async function findClaudeSessionEntries(projectsDir, sessionId) {
  const entries = [];
  let projectDirs = [];
  try {
    projectDirs = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) {
      continue;
    }
    const projectPath = path.join(projectsDir, projectDir.name);
    let files = [];
    try {
      files = await fsp.readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.isFile()) {
        continue;
      }
      if (!file.name.endsWith(".jsonl") || file.name.startsWith("agent-")) {
        continue;
      }

      const filePath = path.join(projectPath, file.name);
      const rl = readline.createInterface({
        input: fs.createReadStream(filePath),
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
        if (entry.sessionId === sessionId) {
          entries.push({ ...entry, source: filePath });
        }
      }
    }
  }

  return entries;
}
