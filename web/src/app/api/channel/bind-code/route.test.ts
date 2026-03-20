import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
import { createMockRequest, createTestToken, extractJson } from '@/__tests__/helpers';
import * as authService from '@/lib/auth/service';

const { mockIssueBindCode } = vi.hoisted(() => ({
  mockIssueBindCode: vi.fn(),
}));

vi.mock('@/lib/channel/service', () => ({
  issueBindCode: mockIssueBindCode,
}));

vi.mock('@/lib/subscription/service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/subscription/service')>();
  return { ...mod, checkAndUpdateExpiredSubscription: vi.fn() };
});

vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'user-1', subscriptionStatus: 'ACTIVE', subscriptionTier: 'PLUS' }) },
  },
}));

describe('/api/channel/bind-code', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authService, 'authenticateToken').mockResolvedValue({ id: 'user-1', email: 'a@b.com', phone: null });
    mockIssueBindCode.mockResolvedValue({ code: 'ABC123', expiresIn: 600 });
  });

  it('returns 401 when unauthenticated', async () => {
    vi.spyOn(authService, 'authenticateToken').mockResolvedValue(null);
    const response = await POST(createMockRequest({ method: 'POST' }));
    const data = await extractJson(response);
    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('issues a bind code for the authenticated user', async () => {
    const token = createTestToken('user-1');
    const response = await POST(createMockRequest({ method: 'POST', token }));
    const data = await extractJson(response);
    expect(response.status).toBe(200);
    expect(data.code).toBe('ABC123');
    expect(mockIssueBindCode).toHaveBeenCalledWith('user-1');
  });
});
