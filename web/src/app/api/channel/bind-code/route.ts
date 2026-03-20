import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSubscription } from '@/lib/auth/middleware';
import { issueBindCode } from '@/lib/channel/service';

export const POST = requireActiveSubscription(async (_request: NextRequest, user) => {
  const result = await issueBindCode(user.id);
  return NextResponse.json(result);
});
