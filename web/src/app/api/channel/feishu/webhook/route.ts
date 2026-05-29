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
  const processedEvents = await Promise.all(events.map(async (event) => ({
    event,
    result: await handleNormalizedInboundEvent(event),
  })));
  const outputs = processedEvents.flatMap(({ result }) => result.outputs);
  const outputCounts: number[] = [];
  let totalOutputs = 0;
  for (const { result } of processedEvents) {
    totalOutputs += result.outputs.length;
    outputCounts.push(totalOutputs);
  }

  await Promise.all(
    processedEvents.flatMap(({ event, result }, index) =>
      result.outputs.flatMap((output) => {
        if (!output?.text?.trim()) return [];
        return [sendFeishuReply({
          config,
          chatId: event.externalChatId,
          replyMessageId: event.externalMessageId,
          text: output.text,
          uuid: `${event.externalMessageId}:${outputCounts[index]}`,
        })];
      }),
    ),
  );

  return NextResponse.json({ processed: events.length, outputs });
}
