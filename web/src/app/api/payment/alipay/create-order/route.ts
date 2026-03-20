import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import { getAlipay } from "@/lib/payment/alipay";
import { db } from "@/lib/db";

export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const alipay = await getAlipay();
  if (!alipay) {
    return NextResponse.json({ error: "Alipay not configured" }, { status: 500 });
  }

  const body = await request.json();
  const amount = body.amount || 10;

  const order = await db.order.create({
    data: {
      userId: user.id,
      amount: amount * 100,
      currency: "CNY",
      provider: "ALIPAY",
      status: "PENDING",
    },
  });

  const result = await alipay.exec("alipay.trade.page.pay", {
    notifyUrl: `${process.env.NEXT_PUBLIC_URL || "http://localhost:6152"}/api/payment/alipay/notify`,
    returnUrl: `${process.env.NEXT_PUBLIC_URL || "http://localhost:6152"}/payment/success?order_id=${order.id}`,
    bizContent: {
      out_trade_no: order.id,
      product_code: "FAST_INSTANT_TRADE_PAY",
      total_amount: amount.toFixed(2),
      subject: "Conductor Subscription",
    },
  });

  return NextResponse.json({ url: result, orderId: order.id });
}
