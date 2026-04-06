import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";

import yaml from "js-yaml";
import {
  filterRuntimeSupportedAllowCliList,
  getExternalRuntimeBackendDescriptor,
  isRuntimeSupportedBackend,
  normalizeRuntimeBackendAlias,
  resolveConfiguredRuntimeBackend,
} from "../runtime-backends.js";

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

function resolveConfigFilePath(options = {}) {
  const configuredPath =
    typeof options?.configFilePath === "string" && options.configFilePath.trim()
      ? options.configFilePath.trim()
      : typeof process.env.CONDUCTOR_CONFIG === "string" && process.env.CONDUCTOR_CONFIG.trim()
        ? process.env.CONDUCTOR_CONFIG.trim()
        : "";
  return configuredPath
    ? path.resolve(configuredPath)
    : path.join(resolveHomeDir(options), ".conductor", "config.yaml");
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
  if (normalizedBackend === "kimi" || normalizedBackend === "kimi-cli" || normalizedBackend === "kimi-code") {
    return ["--session", resumeSessionId];
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
  if (normalizedBackend === "kimi" || normalizedBackend === "kimi-cli" || normalizedBackend === "kimi-code") {
    return "kimi";
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
  if (normalizedProvider === "kimi") {
    return findKimiSessionPath(sessionId, options);
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

export async function findKimiSessionPath(sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  const homeDir = resolveHomeDir(options);
  const sessionsDir = options.kimiSessionsDir || path.join(homeDir, ".kimi", "sessions");
  return findKimiSessionDirectory(sessionsDir, normalizedSessionId);
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
    const externalContext = await resolveExternalResumeContext(backend, normalizedSessionId, options);
    if (externalContext) {
      return externalContext;
    }
    throw new Error(`--resume is not supported for backend "${backend}"`);
  }

  const sessionPath = await findSessionPath(provider, normalizedSessionId, options);
  if (!sessionPath) {
    throw new Error(`Invalid --resume session id for ${provider}: ${normalizedSessionId}`);
  }

  const cwdFromSession = await extractResumeCwdFromSession(
    provider,
    sessionPath,
    normalizedSessionId,
    options,
  );
  const fallbackCwd =
    provider === "kimi" ? null : await resolveSessionRunDirectory(sessionPath);
  const cwd = cwdFromSession || fallbackCwd;
  if (!cwd) {
    if (provider === "kimi") {
      throw new Error(
        `Could not resolve workspace for Kimi session ${normalizedSessionId}. Re-run from the original workspace or resume a session previously started by conductor fire.`,
      );
    }
    throw new Error(`Could not resolve workspace for ${provider} session ${normalizedSessionId}`);
  }
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

function md5Hex(value) {
  return crypto.createHash("md5").update(String(value ?? "")).digest("hex");
}

function listCandidateWorkingDirectories(options = {}) {
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

async function loadConductorSessionRecords(options = {}) {
  const homeDir = resolveHomeDir(options);
  const defaultPaths = [
    path.join(homeDir, ".conductor", "session.yaml"),
    path.join(homeDir, ".conductor", "sessions"),
  ];
  const recordFiles = [];
  const pushFile = (filePath) => {
    const normalized = typeof filePath === "string" ? filePath.trim() : "";
    if (!normalized || recordFiles.includes(normalized)) {
      return;
    }
    recordFiles.push(normalized);
  };

  if (Array.isArray(options.conductorSessionFiles)) {
    for (const entry of options.conductorSessionFiles) {
      pushFile(entry);
    }
  }

  if (Array.isArray(options.conductorSessionDirs)) {
    for (const entry of options.conductorSessionDirs) {
      const normalizedDir = typeof entry === "string" ? entry.trim() : "";
      if (!normalizedDir) {
        continue;
      }
      let files = [];
      try {
        files = await fsp.readdir(normalizedDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".yaml")) {
          continue;
        }
        pushFile(path.join(normalizedDir, file.name));
      }
    }
  } else {
    pushFile(defaultPaths[0]);
    let files = [];
    try {
      files = await fsp.readdir(defaultPaths[1], { withFileTypes: true });
    } catch {
      files = [];
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".yaml")) {
        continue;
      }
      pushFile(path.join(defaultPaths[1], file.name));
    }
  }

  const records = [];
  for (const filePath of recordFiles) {
    let content = "";
    try {
      content = await fsp.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = yaml.load(content);
    } catch {
      continue;
    }
    const entries = Array.isArray(parsed?.sessions) ? parsed.sessions : Array.isArray(parsed) ? parsed : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      records.push({
        ...entry,
        __conductorSourcePath: filePath,
      });
    }
  }
  return records;
}

async function loadConfiguredAllowCliList(options = {}) {
  const configFilePath = resolveConfigFilePath(options);
  let parsed = null;
  try {
    const content = await fsp.readFile(configFilePath, "utf8");
    parsed = yaml.load(content);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || !parsed.allow_cli_list || typeof parsed.allow_cli_list !== "object") {
    return {};
  }
  return filterRuntimeSupportedAllowCliList(parsed.allow_cli_list, { configFilePath });
}

async function resolveResumeLookupBackend(backend, options = {}) {
  const normalizedBackend = normalizeBackend(backend);
  if (!normalizedBackend) {
    return "";
  }
  const configFilePath = resolveConfigFilePath(options);
  const allowCliList =
    options.allowCliList && typeof options.allowCliList === "object"
      ? options.allowCliList
      : await loadConfiguredAllowCliList({ ...options, configFilePath });
  const configuredBackend = await resolveConfiguredRuntimeBackend(normalizedBackend, allowCliList, {
    configFilePath,
  });
  if (configuredBackend?.runtimeBackend) {
    return configuredBackend.runtimeBackend;
  }
  return normalizeRuntimeBackendAlias(normalizedBackend, { configFilePath });
}

function normalizeProjectPathCandidate(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeConductorRecordSourcePath(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function resolveExternalResumeContext(backend, sessionId, options = {}) {
  const configFilePath = resolveConfigFilePath(options);
  const allowCliList = await loadConfiguredAllowCliList({ ...options, configFilePath });
  const normalizedBackend = await resolveResumeLookupBackend(backend, {
    ...options,
    configFilePath,
    allowCliList,
  });
  if (!normalizedBackend || resumeProviderForBackend(normalizedBackend)) {
    return null;
  }
  if (!(await isRuntimeSupportedBackend(normalizedBackend, { configFilePath }))) {
    return null;
  }

  const descriptor = await getExternalRuntimeBackendDescriptor(normalizedBackend, { configFilePath });
  if (typeof descriptor?.resolveResumeContext === "function") {
    const resolvedContext = await descriptor.resolveResumeContext(sessionId, options);
    const cwd = normalizeProjectPathCandidate(resolvedContext?.cwd);
    if (!cwd) {
      throw new Error(`Could not resolve workspace for backend "${normalizedBackend}" session ${sessionId}`);
    }
    if (!(await isExistingDirectory(cwd))) {
      throw new Error(`Resume workspace path does not exist: ${cwd}`);
    }
    const sessionPath = normalizeProjectPathCandidate(resolvedContext?.sessionPath);
    return {
      provider: normalizedBackend,
      sessionId,
      sessionPath,
      cwd,
      debugMetadata: {
        cwdSource:
          typeof resolvedContext?.debugMetadata?.cwdSource === "string" && resolvedContext.debugMetadata.cwdSource.trim()
            ? resolvedContext.debugMetadata.cwdSource.trim()
            : "provider",
        sessionPath,
        ...(resolvedContext?.debugMetadata && typeof resolvedContext.debugMetadata === "object"
          ? resolvedContext.debugMetadata
          : {}),
      },
    };
  }

  const records = await loadConductorSessionRecords(options);
  for (const record of records) {
    const recordSessionId = normalizeSessionId(record?.session_id);
    const recordBackend = await resolveResumeLookupBackend(record?.backend_type, {
      ...options,
      configFilePath,
      allowCliList,
    });
    const projectPath = normalizeProjectPathCandidate(record?.project_path);
    if (recordSessionId !== sessionId || recordBackend !== normalizedBackend || !projectPath) {
      continue;
    }
    if (!(await isExistingDirectory(projectPath))) {
      continue;
    }
    const sessionPath = normalizeConductorRecordSourcePath(record?.__conductorSourcePath);
    return {
      provider: normalizedBackend,
      sessionId,
      sessionPath,
      cwd: projectPath,
      debugMetadata: {
        cwdSource: "conductor_session_record",
        sessionPath,
      },
    };
  }

  for (const candidate of listCandidateWorkingDirectories(options)) {
    if (await isExistingDirectory(candidate)) {
      return {
        provider: normalizedBackend,
        sessionId,
        sessionPath: null,
        cwd: candidate,
        debugMetadata: {
          cwdSource: "current_working_directory",
          sessionPath: null,
        },
      };
    }
  }

  throw new Error(`Could not resolve workspace for backend "${normalizedBackend}" session ${sessionId}`);
}

async function resolveKimiResumeCwd(sessionPath, sessionId, options = {}) {
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

  const records = await loadConductorSessionRecords(options);
  const configFilePath = resolveConfigFilePath(options);
  const allowCliList = await loadConfiguredAllowCliList({ ...options, configFilePath });
  const bySessionId = [];
  const byHash = [];

  for (const record of records) {
    const projectPath = normalizeProjectPathCandidate(record?.project_path);
    if (!projectPath) {
      continue;
    }
    const backendType = await resolveResumeLookupBackend(record?.backend_type, {
      ...options,
      configFilePath,
      allowCliList,
    });
    const recordSessionId = normalizeSessionId(record?.session_id);
    const projectHash = md5Hex(projectPath);
    if (
      recordSessionId === sessionId &&
      (backendType === "kimi" || !backendType) &&
      projectHash === worktreeHash &&
      !bySessionId.includes(projectPath)
    ) {
      bySessionId.push(projectPath);
    }
    if (projectHash === worktreeHash && !byHash.includes(projectPath)) {
      byHash.push(projectPath);
    }
  }

  if (bySessionId.length > 0) {
    return bySessionId[0];
  }
  if (byHash.length === 1) {
    return byHash[0];
  }
  return null;
}

async function extractResumeCwdFromSession(provider, sessionPath, sessionId, options = {}) {
  if (provider === "codex") {
    return extractCodexResumeCwd(sessionPath);
  }
  if (provider === "claude") {
    return extractClaudeResumeCwd(sessionPath, sessionId);
  }
  if (provider === "copilot") {
    return extractCopilotResumeCwd(sessionPath);
  }
  if (provider === "kimi") {
    return resolveKimiResumeCwd(sessionPath, sessionId, options);
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
