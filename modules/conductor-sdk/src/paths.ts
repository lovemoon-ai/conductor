import os from 'node:os';
import path from 'node:path';

export const CONDUCTOR_HOME_ENV_VAR = 'CONDUCTOR_HOME';
export const CONDUCTOR_CONFIG_ENV_VAR = 'CONDUCTOR_CONFIG';

export type ConductorPathEnv = Record<string, string | undefined>;

function normalizeOptionalString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function resolveUserHome(
  env: ConductorPathEnv = process.env,
  fallbackHome: string = os.homedir(),
): string {
  return normalizeOptionalString(env.HOME)
    || normalizeOptionalString(env.USERPROFILE)
    || normalizeOptionalString(fallbackHome)
    || '/tmp';
}

export function resolveHomeRelativePath(
  value: string,
  env: ConductorPathEnv = process.env,
  fallbackHome: string = os.homedir(),
): string {
  const normalized = normalizeOptionalString(value);
  const userHome = resolveUserHome(env, fallbackHome);
  if (normalized === '~') {
    return path.resolve(userHome);
  }
  if (normalized.startsWith('~/') || normalized.startsWith('~\\')) {
    return path.resolve(userHome, normalized.slice(2));
  }
  return path.resolve(normalized);
}

export function resolveConductorHome(env: ConductorPathEnv = process.env): string {
  const configuredHome = normalizeOptionalString(env[CONDUCTOR_HOME_ENV_VAR]);
  if (configuredHome) {
    return resolveHomeRelativePath(configuredHome, env);
  }
  return path.join(path.resolve(resolveUserHome(env)), '.conductor');
}

export function resolveConductorConfigPath(
  explicitPath?: string,
  env: ConductorPathEnv = process.env,
): string {
  const configuredPath = normalizeOptionalString(explicitPath)
    || normalizeOptionalString(env[CONDUCTOR_CONFIG_ENV_VAR]);
  if (configuredPath) {
    return resolveHomeRelativePath(configuredPath, env);
  }
  return path.join(resolveConductorHome(env), 'config.yaml');
}
