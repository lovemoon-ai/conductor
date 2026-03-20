import { NextRequest, NextResponse } from 'next/server';
import { outboxProcessor } from '@/lib/outbox-processor';

/**
 * Outbox Processor Cron Job
 * 每分钟执行一次，处理消息队列
 *
 * 调用方式:
 * - 本地/开发: curl http://localhost:6152/api/cron/outbox-processor?secret=CRON_SECRET
 * - 生产环境: curl -H "Authorization: Bearer CRON_SECRET" http://localhost:6152/api/cron/outbox-processor
 */

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request: NextRequest) {
  // 验证 secret
  const { searchParams } = new URL(request.url);
  const querySecret = searchParams.get('secret');
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.replace('Bearer ', '');

  const providedSecret = querySecret || bearerToken;

  if (!CRON_SECRET || providedSecret !== CRON_SECRET) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  const startTime = Date.now();

  try {
    // 1. 初始化消息TTL（只对新消息生效）
    await outboxProcessor.initializeMessageTTL();

    // 2. 处理待发送消息
    const processResult = await outboxProcessor.processPendingMessages();

    // 3. 清理旧的死信队列消息
    const cleanedCount = await outboxProcessor.cleanupOldDLQ();

    // 4. 获取队列统计
    const stats = await outboxProcessor.getStats();

    const duration = Date.now() - startTime;

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      duration: `${duration}ms`,
      processing: processResult,
      cleanup: {
        oldDLQMessages: cleanedCount
      },
      stats
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[Cron] Outbox processor error:', error);

    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }
}

/**
 * 支持 POST 请求（Vercel Cron 使用）
 */
export async function POST(request: NextRequest) {
  return GET(request);
}
