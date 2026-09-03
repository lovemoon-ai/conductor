import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { resolveClaudeConfigDirs } from "../manager/paths.js";
import {
  buildResumeContext,
  isExistingDirectory,
  normalizeSessionId,
  normalizeSessionTitle,
  pathExists,
  readJsonlHeadEntries,
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

  // Search $CLAUDE_CONFIG_DIR first, then ~/.claude, so sessions recorded
  // before that variable was introduced stay resumable.
  const configDirs = resolveClaudeConfigDirs(options.env ?? process.env, options.homeDir);
  for (const configDir of configDirs) {
    const projectsDir = options.claudeProjectsDir || path.join(configDir, "projects");
    const sessionPath = await findClaudeSessionPath(projectsDir, normalizedSessionId);
    if (sessionPath) {
      return sessionPath;
    }

    const tasksDir = options.claudeTasksDir || path.join(configDir, "tasks");
    const directTaskDir = path.join(tasksDir, normalizedSessionId);
    if (await pathExists(directTaskDir, "directory")) {
      return directTaskDir;
    }
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

/**
 * Lists local Claude Code sessions, newest first.
 *
 * Candidates are collected with readdir + stat only; session files can be tens
 * of megabytes, so file contents (cwd/title) are read - head only - for the
 * `limit` newest files after sorting by mtime.
 */
export async function listSessions(options = {}) {
  const { limit = 20, env = process.env } = options;
  const configDirs = resolveClaudeConfigDirs(env, options.homeDir);
  const scannedProjectsDirs = new Set();
  const candidatesById = new Map();

  for (const configDir of configDirs) {
    const projectsDir = options.claudeProjectsDir || path.join(configDir, "projects");
    if (scannedProjectsDirs.has(projectsDir)) {
      continue;
    }
    scannedProjectsDirs.add(projectsDir);

    let projectDirs = [];
    try {
      projectDirs = await fsp.readdir(projectsDir, { withFileTypes: true });
    } catch {
      continue;
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
        if (!file.isFile() || !file.name.endsWith(".jsonl") || file.name.startsWith("agent-")) {
          continue;
        }
        const sessionId = file.name.slice(0, -".jsonl".length);
        // Config dirs are searched in priority order; the first hit wins.
        if (!sessionId || candidatesById.has(sessionId)) {
          continue;
        }
        const filePath = path.join(projectPath, file.name);
        let stats;
        try {
          stats = await fsp.stat(filePath);
        } catch {
          continue;
        }
        candidatesById.set(sessionId, {
          sessionId,
          sessionFilePath: filePath,
          updatedAt: Math.round(stats.mtimeMs),
        });
      }
    }
  }

  const selected = [...candidatesById.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(0, limit));
  const sessions = [];
  for (const candidate of selected) {
    const entries = await readJsonlHeadEntries(candidate.sessionFilePath);
    sessions.push({
      sessionId: candidate.sessionId,
      sessionFilePath: candidate.sessionFilePath,
      cwd: extractHeadCwd(entries),
      title: extractClaudeTitle(entries),
      updatedAt: candidate.updatedAt,
    });
  }
  return sessions;
}

function extractHeadCwd(entries) {
  for (const entry of entries) {
    if (typeof entry?.cwd === "string" && entry.cwd.trim()) {
      return entry.cwd.trim();
    }
  }
  return null;
}

function extractClaudeTitle(entries) {
  for (const entry of entries) {
    if (entry?.type !== "user" || entry?.isMeta === true) {
      continue;
    }
    const content = entry?.message?.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((item) => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join(" ");
    }
    const title = normalizeSessionTitle(text);
    if (title) {
      return title;
    }
  }
  return null;
}

/**
 * Returns the first session file mentioning `sessionId`. Session ids are
 * unique, so this stops at the first hit instead of walking the whole history
 * tree - which now may live on network storage.
 */
async function findClaudeSessionPath(projectsDir, sessionId) {
  let projectDirs = [];
  try {
    projectDirs = await fsp.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return null;
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
      const input = fs.createReadStream(filePath);
      const rl = readline.createInterface({ input, crlfDelay: Infinity });

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
          // Close both: rl.close() alone leaves the fd open.
          rl.close();
          input.destroy();
          return filePath;
        }
      }
    }
  }

  return null;
}
