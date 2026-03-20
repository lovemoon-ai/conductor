import { db } from '@/lib/db';
import yaml from 'yaml';

export type FeishuProviderConfig = {
  provider: 'FEISHU';
  userId?: string;
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string | null;
  defaultDaemonName: string | null;
};

export type FeishuProviderConfigSummary = {
  provider: 'FEISHU';
  appId: string;
  verificationToken: string;
  hasAppSecret: boolean;
  hasEncryptKey: boolean;
  defaultDaemonName: string | null;
};

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function summarizeConfig(config: FeishuProviderConfig): FeishuProviderConfigSummary {
  return {
    provider: 'FEISHU',
    appId: config.appId,
    verificationToken: config.verificationToken,
    hasAppSecret: Boolean(config.appSecret),
    hasEncryptKey: Boolean(config.encryptKey),
    defaultDaemonName: config.defaultDaemonName,
  };
}

function parseFeishuConfigFromObject(input: unknown): FeishuProviderConfig {
  const root = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const defaultDaemonName = normalizeOptionalString(root.daemon_name);
  const channels = root.channels && typeof root.channels === 'object' && !Array.isArray(root.channels)
    ? root.channels as Record<string, unknown>
    : {};
  const feishu = channels.feishu && typeof channels.feishu === 'object' && !Array.isArray(channels.feishu)
    ? channels.feishu as Record<string, unknown>
    : {};

  const appId = normalizeOptionalString(feishu.app_id);
  const appSecret = normalizeOptionalString(feishu.app_secret);
  const verificationToken = normalizeOptionalString(feishu.verification_token);
  const encryptKey = normalizeOptionalString(feishu.encrypt_key);

  const missingFields = [
    !appId ? 'channels.feishu.app_id' : null,
    !appSecret ? 'channels.feishu.app_secret' : null,
    !verificationToken ? 'channels.feishu.verification_token' : null,
  ].filter(Boolean);

  if (missingFields.length > 0) {
    throw new Error(`Missing Feishu config fields: ${missingFields.join(', ')}`);
  }

  return {
    provider: 'FEISHU',
    appId: appId!,
    appSecret: appSecret!,
    verificationToken: verificationToken!,
    encryptKey,
    defaultDaemonName,
  };
}

export function parseFeishuProviderConfigFromYaml(yamlContent: string): FeishuProviderConfig {
  const parsed = yaml.parse(yamlContent) ?? {};
  return parseFeishuConfigFromObject(parsed);
}

function rowToConfig(row: any): FeishuProviderConfig {
  return {
    provider: 'FEISHU',
    userId: row.userId,
    appId: row.appId,
    appSecret: row.appSecret,
    verificationToken: row.verificationToken,
    encryptKey: row.encryptKey ?? null,
    defaultDaemonName: row.defaultDaemonName ?? null,
  };
}

export async function upsertFeishuProviderConfigFromYaml(userId: string, yamlContent: string): Promise<FeishuProviderConfigSummary> {
  const config = parseFeishuProviderConfigFromYaml(yamlContent);
  const row = await db.channelProviderConfig.upsert({
    where: {
      userId_provider: {
        userId,
        provider: 'FEISHU',
      },
    },
    update: {
      appId: config.appId,
      appSecret: config.appSecret,
      verificationToken: config.verificationToken,
      encryptKey: config.encryptKey,
      defaultDaemonName: config.defaultDaemonName,
    },
    create: {
      userId,
      provider: 'FEISHU',
      appId: config.appId,
      appSecret: config.appSecret,
      verificationToken: config.verificationToken,
      encryptKey: config.encryptKey,
      defaultDaemonName: config.defaultDaemonName,
    },
  });

  return summarizeConfig(rowToConfig(row));
}

export async function getFeishuProviderConfigForUser(userId: string): Promise<FeishuProviderConfig | null> {
  const row = await db.channelProviderConfig.findUnique({
    where: {
      userId_provider: {
        userId,
        provider: 'FEISHU',
      },
    },
  });

  return row ? rowToConfig(row) : null;
}

function getVerificationTokenFromBody(body: any): string | null {
  return normalizeOptionalString(body?.token) ?? normalizeOptionalString(body?.header?.token);
}

export async function resolveFeishuProviderConfigForWebhook(body: any): Promise<FeishuProviderConfig | null> {
  const verificationToken = getVerificationTokenFromBody(body);
  if (!verificationToken) {
    return null;
  }

  const row = await db.channelProviderConfig.findUnique({
    where: {
      provider_verificationToken: {
        provider: 'FEISHU',
        verificationToken,
      },
    },
  });

  return row ? rowToConfig(row) : null;
}

export async function getStoredFeishuProviderConfigSummary(userId: string): Promise<FeishuProviderConfigSummary | null> {
  const config = await getFeishuProviderConfigForUser(userId);
  return config ? summarizeConfig(config) : null;
}
