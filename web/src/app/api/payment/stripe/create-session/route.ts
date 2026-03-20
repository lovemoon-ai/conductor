import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import { stripe } from "@/lib/payment/stripe";
import { db } from "@/lib/db";

export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!stripe) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 500 });
  }

  const body = await request.json();
  const amount = body.amount || 1000;

  const order = await db.order.create({
    data: {
      userId: user.id,
      amount,
      currency: "USD",
      provider: "STRIPE",
      status: "PENDING",
    },
  });

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: "Conductor Subscription" },
          unit_amount: amount,
        },
        quantity: 1,
      },
    ],
    mode: "payment",
    success_url: `${process.env.NEXT_PUBLIC_URL || "http://localhost:6152"}/payment/success?order_id=${order.id}`,
    cancel_url: `${process.env.NEXT_PUBLIC_URL || "http://localhost:6152"}/payment/cancel?order_id=${order.id}`,
    metadata: { orderId: order.id },
  });

  await db.order.update({
    where: { id: order.id },
    data: { providerOrderId: session.id },
  });

  return NextResponse.json({ url: session.url, orderId: order.id });
}
