import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import yaml from "js-yaml";

function normalizeBackend(backend) {
  return String(backend || "").trim().toLowerCase();
}

function resolveHomeDir(options) {
  if (options?.homeDir) {
    return options.homeDir;
  }
  return os.homedir();
}

function normalizeSessionId(sessionId) {
  return typeof sessionId === "string" ? sessionId.trim() : "";
}

export function buildResumeArgsForBackend(backend, sessionId) {
  const resumeSessionId = normalizeSessionId(sessionId);
  if (!resumeSessionId) {
    return [];
  }
  const normalizedBackend = normalizeBackend(backend);
  if (normalizedBackend === "codex" || normalizedBackend === "code") {
    return ["resume", resumeSessionId];
  }
  if (normalizedBackend === "claude" || normalizedBackend === "claude-code") {
    return ["--resume", resumeSessionId];
  }
  if (normalizedBackend === "copilot") {
    return [`--resume=${resumeSessionId}`];
  }
  throw new Error(`--resume is not supported for backend "${backend}"`);
}

export function resumeProviderForBackend(backend) {
  const normalizedBackend = normalizeBackend(backend);
  if (normalizedBackend === "codex" || normalizedBackend === "code") {
    return "codex";
  }
  if (normalizedBackend === "claude" || normalizedBackend === "claude-code") {
    return "claude";
  }
  if (normalizedBackend === "copilot") {
    return "copilot";
  }
  return null;
}

export async function findSessionPath(provider, sessionId, options = {}) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (normalizedProvider === "codex") {
    return findCodexSessionPath(sessionId, options);
  }
  if (normalizedProvider === "claude") {
    return findClaudeSessionPath(sessionId, options);
  }
  if (normalizedProvider === "copilot") {
    return findCopilotSessionPath(sessionId, options);
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

export async function findCodexSessionPath(sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return null;
  }
  const homeDir = resolveHomeDir(options);
  const sessionsDir = options.codexSessionsDir || path.join(homeDir, ".codex", "sessions");
  return findCodexSessionFile(sessionsDir, normalizedSessionId);
}

export async function findClaudeSessionPath(sessionId, options = {}) {
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

export async function findCopilotSessionPath(sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  const homeDir = resolveHomeDir(options);
  const sessionStateDir = options.copilotSessionStateDir || path.join(homeDir, ".copilot", "session-state");
  const directJsonlPath = path.join(sessionStateDir, `${normalizedSessionId}.jsonl`);
  if (await pathExists(directJsonlPath, "file")) {
    return directJsonlPath;
  }

  const directSessionDir = path.join(sessionStateDir, normalizedSessionId);
  if (await pathExists(directSessionDir, "directory")) {
    return directSessionDir;
  }

  return findPathByName(sessionStateDir, normalizedSessionId);
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

export async function inspectResumeTarget(backend, sessionId, options = {}) {
  return resolveResumeContext(backend, sessionId, options);
}

export async function resolveResumeContext(backend, sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error("--resume requires a session id");
  }
  const provider = resumeProviderForBackend(backend);
  if (!provider) {
    throw new Error(`--resume is not supported for backend "${backend}"`);
  }

  const sessionPath = await findSessionPath(provider, normalizedSessionId, options);
  if (!sessionPath) {
    throw new Error(`Invalid --resume session id for ${provider}: ${normalizedSessionId}`);
  }

  const cwdFromSession = await extractResumeCwdFromSession(provider, sessionPath, normalizedSessionId);
  const fallbackCwd = await resolveSessionRunDirectory(sessionPath);
  const cwd = cwdFromSession || fallbackCwd;
  if (!(await isExistingDirectory(cwd))) {
    throw new Error(`Resume workspace path does not exist: ${cwd}`);
  }

  return {
    provider,
    sessionId: normalizedSessionId,
    sessionPath,
    cwd,
    debugMetadata: {
      cwdSource: cwdFromSession ? "session" : "session_path",
      sessionPath,
    },
  };
}

async function isExistingDirectory(targetPath) {
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

async function extractCodexResumeCwd(sessionPath) {
  if (!sessionPath.endsWith(".jsonl")) {
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
    const maybeCwd = entry?.type === "session_meta" ? entry?.payload?.cwd : null;
    if (typeof maybeCwd === "string" && maybeCwd.trim()) {
      return maybeCwd.trim();
    }
  }
  return null;
}

async function extractClaudeResumeCwd(sessionPath, sessionId) {
  if (!sessionPath.endsWith(".jsonl")) {
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

async function extractCopilotResumeCwd(sessionPath) {
  let stats;
  try {
    stats = await fsp.stat(sessionPath);
  } catch {
    return null;
  }

  if (stats.isDirectory()) {
    const workspaceYamlPath = path.join(sessionPath, "workspace.yaml");
    try {
      const yamlContent = await fsp.readFile(workspaceYamlPath, "utf8");
      const parsed = yaml.load(yamlContent);
      const maybeCwd = parsed && typeof parsed === "object" ? parsed.cwd : null;
      if (typeof maybeCwd === "string" && maybeCwd.trim()) {
        return maybeCwd.trim();
      }
    } catch {
      return null;
    }
    return null;
  }

  if (!sessionPath.endsWith(".jsonl")) {
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
    const maybeCwd = entry?.data?.context?.cwd || entry?.data?.cwd;
    if (typeof maybeCwd === "string" && maybeCwd.trim()) {
      return maybeCwd.trim();
    }
  }
  return null;
}

async function extractResumeCwdFromSession(provider, sessionPath, sessionId) {
  if (provider === "codex") {
    return extractCodexResumeCwd(sessionPath);
  }
  if (provider === "claude") {
    return extractClaudeResumeCwd(sessionPath, sessionId);
  }
  if (provider === "copilot") {
    return extractCopilotResumeCwd(sessionPath);
  }
  return null;
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

async function findPathByName(rootDir, sessionId) {
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
      if (entry.name.includes(sessionId)) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        queue.push(fullPath);
      }
    }
  }
  return null;
}

async function pathExists(targetPath, expectedType) {
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
