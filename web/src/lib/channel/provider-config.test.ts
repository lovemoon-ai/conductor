import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockChannelProviderConfigUpsert, mockChannelProviderConfigFindUnique } = vi.hoisted(() => ({
  mockChannelProviderConfigUpsert: vi.fn(),
  mockChannelProviderConfigFindUnique: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    channelProviderConfig: {
      upsert: mockChannelProviderConfigUpsert,
      findUnique: mockChannelProviderConfigFindUnique,
    },
  },
}));

const {
  parseFeishuProviderConfigFromYaml,
  upsertFeishuProviderConfigFromYaml,
} = await import('./provider-config');

describe('channel provider config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelProviderConfigUpsert.mockResolvedValue({
      id: 'cfg-1',
      userId: 'user-1',
      provider: 'FEISHU',
      appId: 'cli_a',
      appSecret: 'cli_s',
      verificationToken: 'verify_t',
      encryptKey: 'encrypt_k',
      defaultDaemonName: 'debug',
    });
  });

  it('parses daemon_name from config yaml as the default feishu daemon', () => {
    const parsed = parseFeishuProviderConfigFromYaml([
      'agent_token: token-1',
      'backend_url: http://localhost:6152',
      'daemon_name: debug',
      'channels:',
      '  feishu:',
      '    app_id: cli_a',
      '    app_secret: cli_s',
      '    verification_token: verify_t',
      '    encrypt_key: encrypt_k',
      '',
    ].join('\n'));

    expect(parsed).toMatchObject({
      appId: 'cli_a',
      verificationToken: 'verify_t',
      defaultDaemonName: 'debug',
    });
  });

  it('stores the parsed default daemon together with feishu credentials', async () => {
    const summary = await upsertFeishuProviderConfigFromYaml('user-1', [
      'daemon_name: debug',
      'channels:',
      '  feishu:',
      '    app_id: cli_a',
      '    app_secret: cli_s',
      '    verification_token: verify_t',
      '',
    ].join('\n'));

    expect(mockChannelProviderConfigUpsert).toHaveBeenCalledWith({
      where: {
        userId_provider: {
          userId: 'user-1',
          provider: 'FEISHU',
        },
      },
      update: expect.objectContaining({
        defaultDaemonName: 'debug',
      }),
      create: expect.objectContaining({
        userId: 'user-1',
        provider: 'FEISHU',
        defaultDaemonName: 'debug',
      }),
    });
    expect(summary).toMatchObject({
      appId: 'cli_a',
      verificationToken: 'verify_t',
      defaultDaemonName: 'debug',
    });
  });
});
