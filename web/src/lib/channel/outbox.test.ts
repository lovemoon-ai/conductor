import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockChannelConversationFindMany,
  mockChannelOutboxCreate,
  mockChannelOutboxFindMany,
  mockChannelOutboxUpdate,
  mockSendFeishuReply,
  mockGetFeishuProviderConfigForUser,
} = vi.hoisted(() => ({
  mockChannelConversationFindMany: vi.fn(),
  mockChannelOutboxCreate: vi.fn(),
  mockChannelOutboxFindMany: vi.fn(),
  mockChannelOutboxUpdate: vi.fn(),
  mockSendFeishuReply: vi.fn(),
  mockGetFeishuProviderConfigForUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    channelConversation: { findMany: mockChannelConversationFindMany },
    channelOutbox: {
      create: mockChannelOutboxCreate,
      findMany: mockChannelOutboxFindMany,
      update: mockChannelOutboxUpdate,
    },
  },
}));

vi.mock('./providers/feishu', () => ({
  sendFeishuReply: mockSendFeishuReply,
}));

vi.mock('./provider-config', () => ({
  getFeishuProviderConfigForUser: mockGetFeishuProviderConfigForUser,
}));

const { enqueueProjectedTaskUpdate, deliverPendingChannelOutbox } = await import('./outbox');

describe('channel outbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelConversationFindMany.mockResolvedValue([
      { id: 'conv-1', provider: 'FEISHU', userId: 'user-1', taskId: 'task-1', externalChatId: 'oc_1', externalRootMessageId: 'om_1' },
    ]);
    mockChannelOutboxCreate.mockResolvedValue({ id: 'out-1' });
    mockChannelOutboxFindMany.mockResolvedValue([
      { id: 'out-1', provider: 'FEISHU', userId: 'user-1', targetChatId: 'oc_1', targetReplyMessageId: 'om_1', payloadJson: JSON.stringify({ text: 'done' }), dedupeKey: 'dedupe-1' },
    ]);
    mockChannelOutboxUpdate.mockResolvedValue({ id: 'out-1' });
    mockGetFeishuProviderConfigForUser.mockResolvedValue({
      provider: 'FEISHU',
      appId: 'cli_a',
      appSecret: 'cli_s',
      verificationToken: 'verify_t',
      encryptKey: null,
    });
    mockSendFeishuReply.mockResolvedValue({ messageId: 'reply-1' });
  });

  it('enqueues projected assistant updates for attached channel conversations', async () => {
    await enqueueProjectedTaskUpdate({
      userId: 'user-1',
      taskId: 'task-1',
      kind: 'assistant_message',
      text: 'done',
    });

    expect(mockChannelConversationFindMany).toHaveBeenCalledWith({ where: { userId: 'user-1', taskId: 'task-1', status: 'ACTIVE' } });
    expect(mockChannelOutboxCreate).toHaveBeenCalled();
  });

  it('delivers pending feishu outbox rows and marks them sent', async () => {
    const result = await deliverPendingChannelOutbox();
    expect(mockGetFeishuProviderConfigForUser).toHaveBeenCalledWith('user-1');
    expect(mockSendFeishuReply).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ appId: 'cli_a', verificationToken: 'verify_t' }),
      chatId: 'oc_1',
      replyMessageId: 'om_1',
      text: 'done',
      uuid: 'dedupe-1',
    }));
    expect(mockChannelOutboxUpdate).toHaveBeenCalled();
    expect(result.delivered).toBe(1);
  });
});
