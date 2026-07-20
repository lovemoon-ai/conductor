import fs from 'node:fs';

import yaml from 'yaml';
import { resolveConductorConfigPath } from '../paths.js';

export const CONFIG_ENV_VAR = 'CONDUCTOR_CONFIG';
export const AGENT_TOKEN_ENV_VAR = 'CONDUCTOR_AGENT_TOKEN';
export const BACKEND_URL_ENV_VAR = 'CONDUCTOR_BACKEND_URL';
export const WS_URL_ENV_VAR = 'CONDUCTOR_WS_URL';
export const LOG_LEVEL_ENV_VAR = 'CONDUCTOR_LOG_LEVEL';

const ALLOWED_LOG_LEVELS = new Set(['debug', 'info', 'warning', 'error', 'critical']);

export class ConfigError extends Error {}
export class ConfigFileNotFound extends ConfigError {
  constructor(public readonly filePath: string) {
    super(`Conductor config file not found at ${filePath}`);
  }
}
export class ConfigValidationError extends ConfigError {
  constructor(public readonly errors: string[]) {
    super(`Invalid Conductor configuration:\n- ${errors.join('\n- ')}`);
  }
}

export interface ConductorConfigInit {
  agentToken: string;
  backendUrl: string;
  websocketUrl?: string;
  logLevel?: string;
  daemonName?: string;
  channels?: ConductorChannelsConfig;
}

export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey?: string;
}

export interface ConductorChannelsConfig {
  feishu?: FeishuChannelConfig;
}

export class ConductorConfig {
  public readonly agentToken: string;
  public readonly backendUrl: string;
  public readonly websocketUrl?: string;
  public readonly logLevel: string;
  public readonly daemonName?: string;
  public readonly channels?: ConductorChannelsConfig;

  constructor(init: ConductorConfigInit) {
    this.agentToken = init.agentToken;
    this.backendUrl = init.backendUrl;
    this.websocketUrl = init.websocketUrl;
    this.logLevel = (init.logLevel || 'info').toLowerCase();
    this.daemonName = normalizeOptionalString(init.daemonName);
    this.channels = init.channels;
  }

  get resolvedWebsocketUrl(): string {
    if (this.websocketUrl) {
      return this.websocketUrl;
    }
    const url = new URL(this.backendUrl);
    const scheme = url.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${url.host}/ws/agent`;
  }

}

export interface LoadConfigOptions {
  env?: Record<string, string | undefined>;
}

export function loadConfig(targetPath?: string, options: LoadConfigOptions = {}): ConductorConfig {
  const env = options.env ?? process.env;
  const configPath = resolveConfigPath(targetPath, env);
  const rawData = readYaml(configPath);
  const merged = applyEnvOverrides(rawData, env);

  const validationErrors: string[] = [];
  const agentToken = normalizeToken(merged.agent_token);
  if (!agentToken) {
    validationErrors.push('agent_token: must be provided');
  }

  let backendUrl: string | undefined;
  if (merged.backend_url) {
    try {
      backendUrl = new URL(String(merged.backend_url)).toString();
    } catch {
      validationErrors.push('backend_url: must be a valid URL');
    }
  } else {
    backendUrl = 'https://api.conductor.local';
  }

  const logLevel = normalizeLogLevel(merged.log_level);
  if (!logLevel) {
    validationErrors.push(`log_level: must be one of ${Array.from(ALLOWED_LOG_LEVELS).join(', ')}`);
  }

  let websocketUrl: string | undefined;
  if (merged.websocket_url) {
    try {
      websocketUrl = new URL(String(merged.websocket_url)).toString();
    } catch {
      validationErrors.push('websocket_url: must be a valid URL');
    }
  }

  if (validationErrors.length) {
    throw new ConfigValidationError(validationErrors);
  }

  return new ConductorConfig({
    agentToken: agentToken!,
    backendUrl: backendUrl!,
    websocketUrl,
    logLevel: logLevel!,
    daemonName: normalizeOptionalString(merged.daemon_name),
    channels: normalizeChannelsConfig(merged.channels),
  });
}

function resolveConfigPath(explicitPath: string | undefined, env: Record<string, string | undefined>): string {
  const normalized = resolveConductorConfigPath(explicitPath, env);
  if (!fs.existsSync(normalized)) {
    throw new ConfigFileNotFound(normalized);
  }
  return normalized;
}

function readYaml(filePath: string): Record<string, any> {
  const content = fs.readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = yaml.parse(content) ?? {};
  } catch (error) {
    throw new ConfigValidationError([`Failed to parse YAML at ${filePath}: ${String(error)}`]);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigValidationError([`Expected mapping at root of ${filePath}`]);
  }
  return parsed as Record<string, any>;
}

function applyEnvOverrides(
  data: Record<string, any>,
  env: Record<string, string | undefined>,
): Record<string, any> {
  const merged = { ...data };
  if (env[AGENT_TOKEN_ENV_VAR]) {
    merged.agent_token = env[AGENT_TOKEN_ENV_VAR];
  }
  if (env[BACKEND_URL_ENV_VAR]) {
    merged.backend_url = env[BACKEND_URL_ENV_VAR];
  }
  if (env[WS_URL_ENV_VAR]) {
    merged.websocket_url = env[WS_URL_ENV_VAR];
  }
  if (env[LOG_LEVEL_ENV_VAR]) {
    merged.log_level = env[LOG_LEVEL_ENV_VAR];
  }
  return merged;
}

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeLogLevel(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return 'info';
  }
  const lowered = value.trim().toLowerCase();
  return ALLOWED_LOG_LEVELS.has(lowered) ? lowered : undefined;
}

function normalizeChannelsConfig(value: unknown): ConductorChannelsConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const feishu = normalizeFeishuChannelConfig(raw.feishu);
  if (!feishu) {
    return undefined;
  }

  return { feishu };
}

function normalizeFeishuChannelConfig(value: unknown): FeishuChannelConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const appId = normalizeOptionalString(raw.app_id);
  const appSecret = normalizeOptionalString(raw.app_secret);
  const verificationToken = normalizeOptionalString(raw.verification_token);
  const encryptKey = normalizeOptionalString(raw.encrypt_key);

  if (!appId || !appSecret || !verificationToken) {
    return undefined;
  }

  return {
    appId,
    appSecret,
    verificationToken,
    ...(encryptKey ? { encryptKey } : {}),
  };
}
