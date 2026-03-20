import { randomUUID } from 'crypto';
import { db } from '@/lib/db';
import { sendFeishuReply } from './providers/feishu';
import { enqueueChannelMessage } from './service';
import { getFeishuProviderConfigForUser } from './provider-config';

let pendingChannelOutboxDelivery: Promise<void> | null = null;

export async function enqueueProjectedTaskUpdate(input: {
  userId: string;
  taskId: string;
  kind: 'assistant_message' | 'task_status';
  text: string;
}) {
  const channelConversationModel = (db as any).channelConversation;
  if (!channelConversationModel?.findMany) {
    return;
  }

  const conversations = await channelConversationModel.findMany({
    where: { userId: input.userId, taskId: input.taskId, status: 'ACTIVE' },
  });

  for (const conversation of conversations) {
    await enqueueChannelMessage({
      provider: conversation.provider,
      userId: input.userId,
      conversationId: conversation.id,
      taskId: input.taskId,
      targetChatId: conversation.externalChatId,
      targetReplyMessageId: conversation.externalRootMessageId ?? null,
      kind: input.kind,
      text: input.text,
      dedupeKey: `${conversation.id}:${input.taskId}:${input.kind}:${randomUUID()}`,
    });
  }

  if (conversations.length > 0) {
    scheduleChannelOutboxDelivery();
  }
}

export async function deliverPendingChannelOutbox(): Promise<{ delivered: number; failed: number }> {
  const channelOutboxModel = (db as any).channelOutbox;
  if (!channelOutboxModel?.findMany || !channelOutboxModel?.update) {
    return { delivered: 0, failed: 0 };
  }

  const rows = await channelOutboxModel.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payloadJson);
      if (row.provider === 'FEISHU') {
        const config = await getFeishuProviderConfigForUser(row.userId);
        if (!config) {
          throw new Error(`Missing Feishu provider config for user ${row.userId}`);
        }
        await sendFeishuReply({
          config,
          chatId: row.targetChatId,
          replyMessageId: row.targetReplyMessageId ?? null,
          text: String(payload.text ?? ''),
          uuid: row.dedupeKey,
        });
      }
      await channelOutboxModel.update({
        where: { id: row.id },
        data: { status: 'sent', sentAt: new Date(), lastError: null, attemptCount: { increment: 1 } },
      });
      delivered += 1;
    } catch (error) {
      await channelOutboxModel.update({
        where: { id: row.id },
        data: { status: 'pending', lastError: error instanceof Error ? error.message : String(error), attemptCount: { increment: 1 } },
      });
      failed += 1;
    }
  }

  return { delivered, failed };
}

function scheduleChannelOutboxDelivery(): void {
  if (process.env.NODE_ENV === 'test') {
    return;
  }
  if (pendingChannelOutboxDelivery) {
    return;
  }

  pendingChannelOutboxDelivery = (async () => {
    try {
      await deliverPendingChannelOutbox();
    } catch (error) {
      console.error('[channel-outbox] immediate delivery failed:', error);
    } finally {
      pendingChannelOutboxDelivery = null;
    }
  })();
}
