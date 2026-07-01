import fs from 'node:fs';
import path from 'node:path';

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function stripWrappingQuotes(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    return normalized.slice(1, -1).trim() || null;
  }
  return normalized;
}

function windowsEnvPath(env: NodeJS.ProcessEnv, key: string): string | null {
  return normalizeOptionalString(env[key]) || normalizeOptionalString(env[key.toUpperCase()]);
}

function pushCandidate(candidates: string[], candidate: unknown): void {
  const normalized = stripWrappingQuotes(candidate);
  if (!normalized || candidates.includes(normalized)) return;
  candidates.push(normalized);
}

function listDirectoryNames(
  root: string,
  readdirSyncFn: typeof fs.readdirSync,
): string[] {
  try {
    return readdirSyncFn(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function visualStudioGitCandidates(env: NodeJS.ProcessEnv, readdirSyncFn: typeof fs.readdirSync): string[] {
  const roots = [
    windowsEnvPath(env, 'ProgramFiles'),
    windowsEnvPath(env, 'ProgramFiles(x86)'),
  ].filter((entry): entry is string => Boolean(entry));
  const candidates: string[] = [];
  for (const root of roots) {
    const vsRoot = path.join(root, 'Microsoft Visual Studio');
    for (const version of listDirectoryNames(vsRoot, readdirSyncFn)) {
      const versionRoot = path.join(vsRoot, version);
      for (const edition of listDirectoryNames(versionRoot, readdirSyncFn)) {
        const gitRoot = path.join(
          versionRoot,
          edition,
          'Common7',
          'IDE',
          'CommonExtensions',
          'Microsoft',
          'TeamFoundation',
          'Team Explorer',
          'Git',
        );
        candidates.push(path.join(gitRoot, 'cmd', 'git.exe'));
        candidates.push(path.join(gitRoot, 'mingw64', 'bin', 'git.exe'));
      }
    }
  }
  return candidates;
}

export interface ResolveGitCommandOptions {
  configuredCommand?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  existsSync?: typeof fs.existsSync;
  readdirSync?: typeof fs.readdirSync;
}

export function resolveGitCommand({
  configuredCommand = null,
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
}: ResolveGitCommandOptions = {}): string {
  const configured = stripWrappingQuotes(configuredCommand);
  if (configured) return configured;
  if (platform !== 'win32') return 'git';

  const candidates: string[] = [];
  pushCandidate(candidates, env.CONDUCTOR_GIT);
  pushCandidate(candidates, env.GIT_EXECUTABLE);

  const localAppData = windowsEnvPath(env, 'LOCALAPPDATA');
  if (localAppData) {
    pushCandidate(candidates, path.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'));
    pushCandidate(candidates, path.join(localAppData, 'Programs', 'Git', 'bin', 'git.exe'));
  }

  const programFiles = windowsEnvPath(env, 'ProgramFiles');
  if (programFiles) {
    pushCandidate(candidates, path.join(programFiles, 'Git', 'cmd', 'git.exe'));
    pushCandidate(candidates, path.join(programFiles, 'Git', 'bin', 'git.exe'));
  }

  const programFilesX86 = windowsEnvPath(env, 'ProgramFiles(x86)');
  if (programFilesX86) {
    pushCandidate(candidates, path.join(programFilesX86, 'Git', 'cmd', 'git.exe'));
    pushCandidate(candidates, path.join(programFilesX86, 'Git', 'bin', 'git.exe'));
  }

  const userProfile = windowsEnvPath(env, 'USERPROFILE');
  if (userProfile) {
    pushCandidate(candidates, path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe'));
    pushCandidate(candidates, path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'mingw64', 'bin', 'git.exe'));
  }

  pushCandidate(candidates, 'C:\\ProgramData\\chocolatey\\bin\\git.exe');
  for (const candidate of visualStudioGitCandidates(env, readdirSync)) {
    pushCandidate(candidates, candidate);
  }

  return candidates.find((candidate) => existsSync(candidate)) || 'git';
}
