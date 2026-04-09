import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadConfig,
  ConfigFileNotFound,
  ConfigValidationError,
  CONFIG_ENV_VAR,
  AGENT_TOKEN_ENV_VAR,
  BACKEND_URL_ENV_VAR,
  WS_URL_ENV_VAR,
  LOG_LEVEL_ENV_VAR,
} from '../src/config/index.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-config-'));
}

function writeConfig(dir: string, contents: string): string {
  const file = path.join(dir, 'config.yaml');
  fs.writeFileSync(file, contents, 'utf-8');
  return file;
}

describe('loadConfig', () => {
  test('loads from explicit path', () => {
    const tempDir = createTempDir();
    const configPath = writeConfig(
      tempDir,
      'agent_token: foo\nbackend_url: https://backend.local\ndaemon_name: workstation-a\n',
    );
    const config = loadConfig(configPath, { env: {} });
    expect(config.agentToken).toBe('foo');
    expect(new URL(config.backendUrl).host).toBe('backend.local');
    expect(config.daemonName).toBe('workstation-a');
  });

  test('throws when config file missing', () => {
    const tempDir = createTempDir();
    const missing = path.join(tempDir, 'missing.yaml');
    expect(() => loadConfig(missing, { env: {} })).toThrow(ConfigFileNotFound);
  });

  test('applies environment overrides', () => {
    const tempDir = createTempDir();
    const configPath = writeConfig(
      tempDir,
      'agent_token: foo\nbackend_url: https://backend.local\nlog_level: warning\n',
    );
    const env = {
      [CONFIG_ENV_VAR]: configPath,
      [AGENT_TOKEN_ENV_VAR]: 'override-token',
      [BACKEND_URL_ENV_VAR]: 'https://override.local',
      [WS_URL_ENV_VAR]: 'wss://override/ws/agent',
      [LOG_LEVEL_ENV_VAR]: 'ERROR',
    } satisfies Record<string, string>;
    const config = loadConfig(undefined, { env });
    expect(config.agentToken).toBe('override-token');
    expect(new URL(config.backendUrl).host).toBe('override.local');
    expect(config.resolvedWebsocketUrl).toBe('wss://override/ws/agent');
    expect(config.logLevel).toBe('error');
  });

  test('invalid log level is reported', () => {
    const tempDir = createTempDir();
    const configPath = writeConfig(tempDir, 'agent_token: foo\nlog_level: verbose\n');
    expect(() => loadConfig(configPath, { env: {} })).toThrow(ConfigValidationError);
  });

  test('loads feishu bot settings from channels config', () => {
    const tempDir = createTempDir();
    const configPath = writeConfig(
      tempDir,
      [
        'agent_token: foo',
        'backend_url: https://backend.local',
        'channels:',
        '  feishu:',
        '    app_id: cli_a',
        '    app_secret: cli_s',
        '    verification_token: verify_t',
        '    encrypt_key: encrypt_k',
        '',
      ].join('\n'),
    );

    const config = loadConfig(configPath, { env: {} });
    expect(config.channels?.feishu).toEqual({
      appId: 'cli_a',
      appSecret: 'cli_s',
      verificationToken: 'verify_t',
      encryptKey: 'encrypt_k',
    });
  });
});
