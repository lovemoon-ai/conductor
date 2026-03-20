export type ChannelProvider = 'FEISHU' | 'SLACK' | 'DINGTALK';

export type NormalizedInboundEvent = {
  provider: ChannelProvider;
  externalUserId: string;
  externalTenantId?: string | null;
  externalChatId: string;
  externalThreadId?: string | null;
  externalTopicId?: string | null;
  externalRootMessageId?: string | null;
  externalMessageId: string;
  externalEventId?: string | null;
  conversationType: 'dm' | 'group';
  text?: string | null;
  mentionsBot: boolean;
  command?: string | null;
  rawPayload: unknown;
};

export type NormalizedOutboundMessage = {
  provider: ChannelProvider;
  userId: string;
  conversationId: string;
  taskId?: string | null;
  targetChatId: string;
  targetReplyMessageId?: string | null;
  targetThreadId?: string | null;
  targetTopicId?: string | null;
  kind: 'assistant_message' | 'task_status' | 'system_notice';
  text: string;
  dedupeKey: string;
  metadata?: Record<string, unknown>;
};
