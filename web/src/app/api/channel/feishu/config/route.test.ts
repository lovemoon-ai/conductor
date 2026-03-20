import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockRequest, createTestToken, extractJson } from '@/__tests__/helpers';
import * as authService from '@/lib/auth/service';

const { mockUpsertFeishuProviderConfigFromYaml } = vi.hoisted(() => ({
  mockUpsertFeishuProviderConfigFromYaml: vi.fn(),
}));

vi.mock('@/lib/channel/provider-config', () => ({
  upsertFeishuProviderConfigFromYaml: mockUpsertFeishuProviderConfigFromYaml,
}));

vi.mock('@/lib/subscription/service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/subscription/service')>();
  return { ...mod, checkAndUpdateExpiredSubscription: vi.fn() };
});

vi.mock('@/lib/db', () => ({
  db: {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'user-1',
        subscriptionStatus: 'ACTIVE',
        subscriptionTier: 'PLUS',
      }),
    },
  },
}));

const { POST } = await import('./route');

describe('/api/channel/feishu/config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authService, 'authenticateToken').mockResolvedValue({
      id: 'user-1',
      email: 'feishu@example.com',
      phone: null,
    });
    mockUpsertFeishuProviderConfigFromYaml.mockResolvedValue({
      provider: 'FEISHU',
      appId: 'cli_a',
      verificationToken: 'verify_t',
      hasAppSecret: true,
      hasEncryptKey: true,
      defaultDaemonName: 'debug',
    });
  });

  it('returns 401 when unauthenticated', async () => {
    vi.spyOn(authService, 'authenticateToken').mockResolvedValue(null);

    const response = await POST(createMockRequest({
      method: 'POST',
      body: { yaml: 'channels:\n  feishu:\n    app_id: cli_a\n' },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('imports feishu settings from config yaml for the authenticated user', async () => {
    const response = await POST(createMockRequest({
      method: 'POST',
      token: createTestToken('user-1'),
      body: {
        yaml: [
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
      },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(mockUpsertFeishuProviderConfigFromYaml).toHaveBeenCalledWith('user-1', expect.stringContaining('channels:'));
    expect(data.config).toEqual({
      provider: 'FEISHU',
      appId: 'cli_a',
      verificationToken: 'verify_t',
      hasAppSecret: true,
      hasEncryptKey: true,
      defaultDaemonName: 'debug',
    });
  });
});
