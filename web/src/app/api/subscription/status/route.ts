import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth/middleware';
import { getSubscriptionStatus, checkAndUpdateExpiredSubscription } from '@/lib/subscription/service';

export async function GET(req: NextRequest) {
  try {
    const user = await getAuthUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check and update expired subscription
    await checkAndUpdateExpiredSubscription(user.id);

    // Get current subscription status
    const status = await getSubscriptionStatus(user.id);

    return NextResponse.json(status);
  } catch (error) {
    console.error('Error getting subscription status:', error);
    return NextResponse.json(
      { error: 'Failed to get subscription status' },
      { status: 500 }
    );
  }
}
