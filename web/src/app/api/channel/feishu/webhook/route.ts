import { NextRequest, NextResponse } from 'next/server';
import { sendFeishuReply, normalizeFeishuRequest } from '@/lib/channel/providers/feishu';
import { resolveFeishuProviderConfigForWebhook } from '@/lib/channel/provider-config';
import { handleNormalizedInboundEvent } from '@/lib/channel/service';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);

  if (body?.type === 'url_verification' && typeof body.challenge === 'string') {
    return NextResponse.json({ challenge: body.challenge });
  }

  const config = await resolveFeishuProviderConfigForWebhook(body);
  if (!config) {
    return NextResponse.json({ error: 'Invalid Feishu verification token' }, { status: 401 });
  }

  const events = await normalizeFeishuRequest(body);
  const outputs: Array<{ text: string }> = [];

  for (const event of events) {
    const result = await handleNormalizedInboundEvent(event);
    outputs.push(...result.outputs);

    for (const output of result.outputs) {
      if (!output?.text?.trim()) continue;
      await sendFeishuReply({
        config,
        chatId: event.externalChatId,
        replyMessageId: event.externalMessageId,
        text: output.text,
        uuid: `${event.externalMessageId}:${outputs.length}`,
      });
    }
  }

  return NextResponse.json({ processed: events.length, outputs });
}
