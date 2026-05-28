/**
 * Outbox Processor
 * 处理消息队列，支持TTL、指数退避重试、死信队列
 */

import { db as prisma } from './db';
import { realtimeHub } from './realtime/hub';

interface OutboxConfig {
  maxAttempts: number;
  ttlHours: number;
  baseRetryIntervalMs: number;
  maxRetryIntervalMs: number;
  batchSize: number;
}

const DEFAULT_CONFIG: OutboxConfig = {
  maxAttempts: 20,
  ttlHours: 24,
  baseRetryIntervalMs: 30000, // 30秒
  maxRetryIntervalMs: 300000, // 5分钟
  batchSize: 100
};

const OFFLINE_FAILURE_ATTEMPT_THRESHOLD = 3;

class OutboxProcessor {
  private config: OutboxConfig;

  constructor(config: Partial<OutboxConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 初始化消息TTL
   */
  async initializeMessageTTL(): Promise<void> {
    const now = Date.now();
    const expiresAt = new Date(now + this.config.ttlHours * 60 * 60 * 1000);

    await prisma.agentOutbox.updateMany({
      where: {
        status: 'pending',
        expiresAt: null
      },
      data: {
        expiresAt,
        maxAttempts: this.config.maxAttempts,
        ttlHours: this.config.ttlHours
      }
    });
  }

  /**
   * 处理所有待处理的消息
   */
  async processPendingMessages(): Promise<{
    processed: number;
    sent: number;
    failed: number;
    expired: number;
    movedToDLQ: number;
  }> {
    const stats = {
      processed: 0,
      sent: 0,
      failed: 0,
      expired: 0,
      movedToDLQ: 0
    };

    try {
      // 1. 标记过期消息
      const expiredCount = await this.markExpiredMessages();
      stats.expired = expiredCount;

      // 2. 处理正常待发送消息
      const messages = await prisma.agentOutbox.findMany({
        where: {
          status: 'pending',
          attemptCount: { lt: this.config.maxAttempts },
          expiresAt: { gt: new Date() },
          OR: [
            { nextRetryAt: { lte: new Date() } },
            { nextRetryAt: null }
          ]
        },
        orderBy: { createdAt: 'asc' },
        take: this.config.batchSize
      });

      // Process messages sequentially to preserve ordering and stagger retries.
      for (const message of messages) {
        const result = await this.processMessage(message);
        stats.processed++;

        switch (result) {
          case 'sent':
            stats.sent++;
            break;
          case 'failed':
            stats.failed++;
            break;
          case 'dlq':
            stats.movedToDLQ++;
            break;
        }
      }

      // 3. 将超过最大重试次数的消息移入死信队列
      const dlqCount = await this.moveFailedToDLQ();
      stats.movedToDLQ += dlqCount;

      return stats;
    } catch (error) {
      console.error('[OutboxProcessor] Error processing messages:', error);
      return stats;
    }
  }

  /**
   * 处理单条消息
   */
  private async processMessage(
    message: { id: string; agentHost: string | null; attemptCount: number; payloadJson: string; userId: string }
  ): Promise<'sent' | 'failed' | 'dlq'> {
    try {
      // Use websocket presence as the single source of truth for agent liveness.
      if (message.agentHost && !realtimeHub.hasAgentHost(message.agentHost, message.userId)) {
        // Agent离线，延迟重试
        await this.scheduleRetry(message.id, message.attemptCount, 'Agent offline');
        return 'failed';
      }

      // 尝试发送消息
      await this.sendToAgent(message);

      // 标记为已发送
      await prisma.agentOutbox.update({
        where: { id: message.id },
        data: {
          status: 'sent',
          sentAt: new Date(),
          updatedAt: new Date()
        }
      });

      return 'sent';
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const shouldRetry = message.attemptCount < this.config.maxAttempts - 1;

      if (shouldRetry) {
        await this.scheduleRetry(message.id, message.attemptCount, errorMessage);
        return 'failed';
      } else {
        // 超过最大重试次数，稍后移入DLQ
        await prisma.agentOutbox.update({
          where: { id: message.id },
          data: {
            lastError: errorMessage,
            updatedAt: new Date()
          }
        });
        return 'dlq';
      }
    }
  }

  /**
   * 发送消息到Agent
   */
  private async sendToAgent(message: { payloadJson: string; userId: string }): Promise<void> {
    // 实际发送逻辑应该在这里实现
    // 这里只是一个占位符，实际实现需要与agent-gateway集成
    console.log(`[OutboxProcessor] Sending message for user: ${message.userId}`);

    // 模拟发送成功
    // 实际实现应该调用 WebSocket 或其他通信方式
  }

  /**
   * 安排重试
   */
  private async scheduleRetry(
    messageId: string,
    attemptCount: number,
    errorMessage: string
  ): Promise<void> {
    const nextRetry = this.calculateNextRetry(attemptCount);

    await prisma.agentOutbox.update({
      where: { id: messageId },
      data: {
        attemptCount: { increment: 1 },
        nextRetryAt: nextRetry,
        lastError: errorMessage,
        updatedAt: new Date()
      }
    });
  }

  /**
   * 计算下次重试时间（指数退避）
   */
  private calculateNextRetry(attemptCount: number): Date {
    const delay = Math.min(
      this.config.baseRetryIntervalMs * Math.pow(2, attemptCount),
      this.config.maxRetryIntervalMs
    );
    return new Date(Date.now() + delay);
  }

  /**
   * 标记过期消息
   */
  private async markExpiredMessages(): Promise<number> {
    const now = new Date();

    const result = await prisma.agentOutbox.updateMany({
      where: {
        status: 'pending',
        expiresAt: { lte: now }
      },
      data: {
        status: 'expired',
        lastError: 'Message TTL expired',
        updatedAt: now
      }
    });

    if (result.count > 0) {
      console.log(`[OutboxProcessor] Marked ${result.count} messages as expired`);
    }

    return result.count;
  }

  /**
   * 将超过最大重试次数的消息移入死信队列
   */
  private async moveFailedToDLQ(): Promise<number> {
    const failedMessages = await prisma.agentOutbox.findMany({
      where: {
        status: 'pending',
        attemptCount: { gte: this.config.maxAttempts }
      }
    });

    let movedCount = 0;

    for (const message of failedMessages) {
      try {
        await prisma.$transaction(async (tx) => {
          // 插入死信队列
          await tx.deadLetterQueue.create({
            data: {
              originalId: message.id,
              userId: message.userId,
              agentHost: message.agentHost,
              taskId: message.taskId,
              eventType: message.eventType,
              payload: message.payloadJson,
              failedReason: message.lastError || 'Max retry attempts exceeded',
              attemptHistory: JSON.stringify({
                count: message.attemptCount,
                lastError: message.lastError,
                createdAt: message.createdAt,
                updatedAt: message.updatedAt
              })
            }
          });

          // 标记为已移入DLQ
          await tx.agentOutbox.update({
            where: { id: message.id },
            data: {
              status: 'moved_to_dlq',
              updatedAt: new Date()
            }
          });
        });

        movedCount++;
      } catch (error) {
        console.error(`[OutboxProcessor] Error moving message ${message.id} to DLQ:`, error);
      }
    }

    if (movedCount > 0) {
      console.log(`[OutboxProcessor] Moved ${movedCount} messages to DLQ`);
    }

    return movedCount;
  }

  /**
   * 清理旧的死信队列消息（保留30天）
   */
  async cleanupOldDLQ(): Promise<number> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const result = await prisma.deadLetterQueue.deleteMany({
      where: { createdAt: { lt: thirtyDaysAgo } }
    });

    if (result.count > 0) {
      console.log(`[OutboxProcessor] Cleaned up ${result.count} old DLQ messages`);
    }

    return result.count;
  }

  async handleDisconnectedAgent(agentHost: string, userId: string): Promise<number> {
    const normalizedHost = agentHost.trim();
    if (!normalizedHost) {
      return 0;
    }

    if (realtimeHub.hasAgentHost(normalizedHost, userId)) {
      return 0;
    }

    try {
      const result = await prisma.agentOutbox.updateMany({
        where: {
          agentHost: normalizedHost,
          userId,
          status: 'pending',
          attemptCount: { gte: OFFLINE_FAILURE_ATTEMPT_THRESHOLD }
        },
        data: {
          status: 'failed',
          lastError: `Agent host offline: ${normalizedHost}`,
          updatedAt: new Date()
        }
      });

      if (result.count > 0) {
        console.log(
          `[OutboxProcessor] Marked ${result.count} messages as failed for disconnected agent: ${normalizedHost}`,
        );
      }

      return result.count;
    } catch (error) {
      console.error('[OutboxProcessor] Error handling disconnected agent:', error);
      return 0;
    }
  }

  /**
   * 从死信队列重试消息
   */
  async retryFromDLQ(originalId: string): Promise<boolean> {
    try {
      const dlqMsg = await prisma.deadLetterQueue.findFirst({
        where: { originalId }
      });

      if (!dlqMsg) {
        console.error(`[OutboxProcessor] DLQ message not found: ${originalId}`);
        return false;
      }

      await prisma.$transaction(async (tx) => {
        // 重新创建消息
        await tx.agentOutbox.create({
          data: {
            userId: dlqMsg.userId,
            agentHost: dlqMsg.agentHost,
            taskId: dlqMsg.taskId,
            eventType: dlqMsg.eventType,
            requestId: `retry-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            payloadJson: dlqMsg.payload,
            status: 'pending',
            attemptCount: 0,
            maxAttempts: this.config.maxAttempts,
            ttlHours: this.config.ttlHours,
            expiresAt: new Date(Date.now() + this.config.ttlHours * 60 * 60 * 1000)
          }
        });

        // 从DLQ移除
        await tx.deadLetterQueue.delete({
          where: { id: dlqMsg.id }
        });
      });

      console.log(`[OutboxProcessor] Retried message from DLQ: ${originalId}`);
      return true;
    } catch (error) {
      console.error(`[OutboxProcessor] Error retrying DLQ message ${originalId}:`, error);
      return false;
    }
  }

  /**
   * 获取队列统计
   */
  async getStats(): Promise<{
    pending: number;
    sent: number;
    acked: number;
    failed: number;
    expired: number;
    dlq: number;
  }> {
    const [
      pending,
      sent,
      acked,
      failed,
      expired,
      dlq
    ] = await Promise.all([
      prisma.agentOutbox.count({ where: { status: 'pending' } }),
      prisma.agentOutbox.count({ where: { status: 'sent' } }),
      prisma.agentOutbox.count({ where: { status: 'acked' } }),
      prisma.agentOutbox.count({ where: { status: 'failed' } }),
      prisma.agentOutbox.count({ where: { status: 'expired' } }),
      prisma.deadLetterQueue.count()
    ]);

    return { pending, sent, acked, failed, expired, dlq };
  }
}

// 单例导出
export { OutboxProcessor };
export const outboxProcessor = new OutboxProcessor();
