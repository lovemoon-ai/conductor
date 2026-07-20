import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import yaml from "js-yaml";
import {
  buildResumeArgsForBackend as buildResumeArgsForBackendFromSdk,
  findSessionPath as findSessionPathFromSdk,
  resolveResumeContext as resolveResumeContextFromSdk,
  resolveSessionRunDirectory as resolveSessionRunDirectoryFromSdk,
  resumeProviderForBackend as resumeProviderForBackendFromSdk,
} from "@love-moon/ai-sdk";

import {
  filterRuntimeSupportedAllowCliList,
  getExternalRuntimeBackendDescriptor,
  isRuntimeSupportedBackend,
  normalizeRuntimeBackendAlias,
  resolveConfiguredRuntimeBackend,
} from "../runtime-backends.js";
import { resolveConductorConfigPath, resolveConductorHome } from "../conductor-paths.js";

function normalizeBackend(backend) {
  return String(backend || "").trim().toLowerCase();
}

function normalizeSessionId(sessionId) {
  return typeof sessionId === "string" ? sessionId.trim() : "";
}

function resolveConductorStorageDir(options = {}) {
  if (typeof options.conductorHome === "string" && options.conductorHome.trim()) {
    return path.resolve(options.conductorHome.trim());
  }
  const env = options.env || process.env;
  if (typeof options.homeDir === "string" && options.homeDir.trim()) {
    return resolveConductorHome(env, { userHome: options.homeDir.trim() });
  }
  return resolveConductorHome(env);
}

function resolveConfigFilePath(options = {}) {
  const env = options.env || process.env;
  if (typeof options.homeDir === "string" && options.homeDir.trim() && !env.CONDUCTOR_HOME) {
    return resolveConductorConfigPath(options.configFilePath, env, { userHome: options.homeDir.trim() });
  }
  return resolveConductorConfigPath(options.configFilePath, env);
}

function normalizeProjectPathCandidate(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeConductorRecordSourcePath(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

function md5Hex(value) {
  return crypto.createHash("md5").update(String(value ?? "")).digest("hex");
}

async function loadConductorSessionRecords(options = {}) {
  const conductorHome = resolveConductorStorageDir(options);
  const defaultPaths = [
    path.join(conductorHome, "session.yaml"),
    path.join(conductorHome, "sessions"),
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

async function loadParsedConfigFile(options = {}) {
  const configFilePath = resolveConfigFilePath(options);
  try {
    const content = await fsp.readFile(configFilePath, "utf8");
    const parsed = yaml.load(content);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function loadConfiguredAllowCliList(options = {}) {
  const configFilePath = resolveConfigFilePath(options);
  const parsed = await loadParsedConfigFile({ ...options, configFilePath });
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

async function kimiWorkspaceLookupFromConductorRecords(worktreeHash, options, sessionId) {
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

async function resolveExternalResumeContextFromConductorRecords(backend, sessionId, options = {}) {
  const configFilePath = resolveConfigFilePath(options);
  const allowCliList =
    options.allowCliList && typeof options.allowCliList === "object"
      ? options.allowCliList
      : await loadConfiguredAllowCliList({ ...options, configFilePath });
  const normalizedBackend = await resolveResumeLookupBackend(backend, {
    ...options,
    configFilePath,
    allowCliList,
  });
  if (!normalizedBackend || resumeProviderForBackendFromSdk(normalizedBackend)) {
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

// ---------------------------------------------------------------------------
// Public API — thin facade over `@love-moon/ai-sdk` resume.
// ---------------------------------------------------------------------------

export function buildResumeArgsForBackend(backend, sessionId) {
  return buildResumeArgsForBackendFromSdk(backend, sessionId);
}

export function resumeProviderForBackend(backend) {
  return resumeProviderForBackendFromSdk(backend);
}

export async function findSessionPath(provider, sessionId, options = {}) {
  return findSessionPathFromSdk(provider, sessionId, options);
}

export async function findCodexSessionPath(sessionId, options = {}) {
  return findSessionPathFromSdk("codex", sessionId, options);
}

export async function findClaudeSessionPath(sessionId, options = {}) {
  return findSessionPathFromSdk("claude", sessionId, options);
}

export async function findKimiSessionPath(sessionId, options = {}) {
  return findSessionPathFromSdk("kimi", sessionId, options);
}

export async function resolveSessionRunDirectory(sessionPath) {
  return resolveSessionRunDirectoryFromSdk(sessionPath);
}

export async function inspectResumeTarget(backend, sessionId, options = {}) {
  return resolveResumeContext(backend, sessionId, options);
}

export async function resolveResumeContext(backend, sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error("--resume requires a session id");
  }
  const configFilePath = resolveConfigFilePath(options);
  const allowCliList =
    options.allowCliList && typeof options.allowCliList === "object"
      ? options.allowCliList
      : await loadConfiguredAllowCliList({ ...options, configFilePath });
  const lookupBackend = await resolveResumeLookupBackend(backend, {
    ...options,
    configFilePath,
    allowCliList,
  });
  const effectiveBackend = lookupBackend || backend;
  const provider = resumeProviderForBackendFromSdk(effectiveBackend);

  if (!provider) {
    const externalContext = await resolveExternalResumeContextFromConductorRecords(backend, normalizedSessionId, {
      ...options,
      configFilePath,
      allowCliList,
    });
    if (externalContext) {
      return externalContext;
    }
    throw new Error(`--resume is not supported for backend "${backend}"`);
  }

  const sdkOptions = {
    ...options,
    configFilePath,
    allowCliList,
    backend,
    runtimeBackend: effectiveBackend,
  };

  if (provider === "kimi" && typeof sdkOptions.lookupWorkspaceByHash !== "function") {
    sdkOptions.lookupWorkspaceByHash = async (worktreeHash, ctx = {}) =>
      kimiWorkspaceLookupFromConductorRecords(worktreeHash, options, ctx.sessionId || normalizedSessionId);
  }

  return resolveResumeContextFromSdk(effectiveBackend, normalizedSessionId, sdkOptions);
}
