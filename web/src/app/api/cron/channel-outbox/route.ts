import { NextRequest, NextResponse } from 'next/server';
import { deliverPendingChannelOutbox } from '@/lib/channel/outbox';

export async function POST(_request: NextRequest) {
  const result = await deliverPendingChannelOutbox();
  return NextResponse.json(result);
}
