import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSubscription } from '@/lib/auth/middleware';
import { upsertFeishuProviderConfigFromYaml } from '@/lib/channel/provider-config';

export const POST = requireActiveSubscription(async (request: NextRequest, user) => {
  const body = await request.json().catch(() => null);
  const yaml = typeof body?.yaml === 'string' ? body.yaml : '';

  if (!yaml.trim()) {
    return NextResponse.json({ error: 'yaml is required' }, { status: 400 });
  }

  try {
    const config = await upsertFeishuProviderConfigFromYaml(user.id, yaml);
    return NextResponse.json({ config });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
});
