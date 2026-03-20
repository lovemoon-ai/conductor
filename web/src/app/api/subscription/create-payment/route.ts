import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth/middleware';
import { getAlipay } from '@/lib/payment/alipay';
import { stripe } from '@/lib/payment/stripe';
import { db } from '@/lib/db';
import { PLUS_PRICE_CNY, PLUS_PRICE_USD } from '@/lib/subscription/service';

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUser(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const provider = String(body?.provider || 'ALIPAY').toUpperCase();
    const baseUrl =
      process.env.NEXT_PUBLIC_BASE_URL ||
      process.env.NEXT_PUBLIC_URL ||
      'http://localhost:6152';

    if (provider === 'STRIPE') {
      if (!stripe) {
        return NextResponse.json(
          { error: 'Stripe not configured' },
          { status: 500 }
        );
      }

      const order = await db.order.create({
        data: {
          userId: user.id,
          amount: PLUS_PRICE_USD,
          currency: 'USD',
          provider: 'STRIPE',
          status: 'PENDING',
          metadata: JSON.stringify({
            type: 'subscription',
            tier: 'PLUS',
          }),
        },
      });

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: { name: 'Conductor Plus Subscription' },
              unit_amount: PLUS_PRICE_USD,
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: `${baseUrl}/payment/success?order_id=${order.id}`,
        cancel_url: `${baseUrl}/payment/cancel?order_id=${order.id}`,
        metadata: { orderId: order.id, type: 'subscription', tier: 'PLUS' },
      });

      await db.order.update({
        where: { id: order.id },
        data: { providerOrderId: session.id },
      });

      return NextResponse.json({
        orderId: order.id,
        paymentUrl: session.url,
      });
    }

    const alipay = await getAlipay();
    if (!alipay) {
      return NextResponse.json(
        { error: 'Alipay not configured' },
        { status: 500 }
      );
    }

    const order = await db.order.create({
      data: {
        userId: user.id,
        amount: PLUS_PRICE_CNY,
        currency: 'CNY',
        provider: 'ALIPAY',
        status: 'PENDING',
        metadata: JSON.stringify({
          type: 'subscription',
          tier: 'PLUS',
        }),
      },
    });

    const result = await alipay.pageExecute('alipay.trade.page.pay', 'POST', {
      notifyUrl: `${baseUrl}/api/payment/alipay/notify`,
      returnUrl: `${baseUrl}/payment/success?order_id=${order.id}`,
      bizContent: {
        out_trade_no: order.id,
        product_code: 'FAST_INSTANT_TRADE_PAY',
        total_amount: (PLUS_PRICE_CNY / 100).toFixed(2),
        subject: 'Conductor Plus 订阅 - 1个月',
        body: 'Conductor Plus 月度订阅服务',
      },
    });

    return NextResponse.json({
      orderId: order.id,
      paymentUrl: result,
    });
  } catch (error) {
    console.error('Error creating payment order:', error);
    return NextResponse.json(
      { error: 'Failed to create payment order' },
      { status: 500 }
    );
  }
}
