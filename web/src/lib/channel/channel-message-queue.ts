import { db } from '@/lib/db';
import type { NormalizedOutboundMessage } from './types';

export async function enqueueChannelMessage(input: NormalizedOutboundMessage): Promise<void> {
  await (db as any).channelOutbox.create({
    data: {
      provider: input.provider,
      userId: input.userId,
      conversationId: input.conversationId,
      taskId: input.taskId ?? null,
      targetChatId: input.targetChatId,
      targetReplyMessageId: input.targetReplyMessageId ?? null,
      targetThreadId: input.targetThreadId ?? null,
      targetTopicId: input.targetTopicId ?? null,
      eventType: input.kind,
      dedupeKey: input.dedupeKey,
      payloadJson: JSON.stringify({ text: input.text, metadata: input.metadata ?? null }),
      status: 'pending',
      attemptCount: 0,
    },
  });
}
