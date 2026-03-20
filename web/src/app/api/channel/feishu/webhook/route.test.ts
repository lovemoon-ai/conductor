import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
import { createMockRequest, extractJson } from '@/__tests__/helpers';

const {
  mockNormalizeFeishuRequest,
  mockHandleNormalizedInboundEvent,
  mockSendFeishuReply,
  mockResolveFeishuProviderConfigForWebhook,
} = vi.hoisted(() => ({
  mockNormalizeFeishuRequest: vi.fn(),
  mockHandleNormalizedInboundEvent: vi.fn(),
  mockSendFeishuReply: vi.fn(),
  mockResolveFeishuProviderConfigForWebhook: vi.fn(),
}));

vi.mock('@/lib/channel/providers/feishu', () => ({
  normalizeFeishuRequest: mockNormalizeFeishuRequest,
  sendFeishuReply: mockSendFeishuReply,
}));

vi.mock('@/lib/channel/service', () => ({
  handleNormalizedInboundEvent: mockHandleNormalizedInboundEvent,
}));

vi.mock('@/lib/channel/provider-config', () => ({
  resolveFeishuProviderConfigForWebhook: mockResolveFeishuProviderConfigForWebhook,
}));

describe('/api/channel/feishu/webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveFeishuProviderConfigForWebhook.mockResolvedValue({
      provider: 'FEISHU',
      appId: 'cli_a',
      appSecret: 'cli_s',
      verificationToken: 'expected-token',
      encryptKey: 'encrypt_k',
    });
    mockSendFeishuReply.mockResolvedValue({ messageId: 'reply-1' });
  });

  afterEach(() => {
  });

  it('returns the challenge for feishu url verification', async () => {
    const response = await POST(createMockRequest({ method: 'POST', body: { type: 'url_verification', challenge: 'abc' } }));
    const data = await extractJson(response);
    expect(response.status).toBe(200);
    expect(data.challenge).toBe('abc');
    expect(mockResolveFeishuProviderConfigForWebhook).not.toHaveBeenCalled();
  });

  it('rejects requests when no persisted feishu config matches the callback token', async () => {
    mockResolveFeishuProviderConfigForWebhook.mockResolvedValue(null);

    const response = await POST(
      createMockRequest({
        method: 'POST',
        body: { schema: '2.0', header: { token: 'wrong-token' }, event: {} },
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(401);
    expect(data.error).toBe('Invalid Feishu verification token');
  });

  it('normalizes inbound feishu messages, sends provider-visible replies, and returns adapter outputs', async () => {
    mockNormalizeFeishuRequest.mockResolvedValue([
      {
        provider: 'FEISHU',
        externalUserId: 'ou_1',
        externalChatId: 'oc_1',
        externalMessageId: 'om_1',
        externalEventId: 'evt_1',
        conversationType: 'dm',
        mentionsBot: false,
        text: 'hello',
        rawPayload: {},
      },
    ]);
    mockHandleNormalizedInboundEvent.mockResolvedValue({ outputs: [{ text: 'ok' }] });

    const response = await POST(createMockRequest({ method: 'POST', body: { schema: '2.0', header: {}, event: {} } }));
    const data = await extractJson(response);
    expect(response.status).toBe(200);
    expect(mockResolveFeishuProviderConfigForWebhook).toHaveBeenCalled();
    expect(mockNormalizeFeishuRequest).toHaveBeenCalled();
    expect(mockHandleNormalizedInboundEvent).toHaveBeenCalled();
    expect(mockSendFeishuReply).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ appId: 'cli_a', verificationToken: 'expected-token' }),
        chatId: 'oc_1',
        replyMessageId: 'om_1',
        text: 'ok',
      }),
    );
    expect(data.processed).toBe(1);
    expect(data.outputs).toEqual([{ text: 'ok' }]);
  });
});
