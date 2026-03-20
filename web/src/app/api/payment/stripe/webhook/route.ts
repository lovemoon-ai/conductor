import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/payment/stripe";
import { db } from "@/lib/db";
import { renewPlusSubscription } from "@/lib/subscription/service";

export async function POST(request: NextRequest) {
  if (!stripe) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 500 });
  }

  const body = await request.text();
  const sig = request.headers.get("stripe-signature");

  if (!sig || !process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  try {
    const event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const orderId = session.metadata?.orderId;

      if (orderId) {
        const order = await db.order.findUnique({ where: { id: orderId } });
        if (order && order.status !== "COMPLETED") {
          await db.order.update({
            where: { id: orderId },
            data: { status: "COMPLETED", providerOrderId: session.id },
          });

          let metadata: any = {};
          try {
            metadata = order.metadata ? JSON.parse(order.metadata) : {};
          } catch (e) {
            console.error("Failed to parse order metadata:", e);
          }

          if (metadata.type === "subscription" && metadata.tier === "PLUS") {
            await renewPlusSubscription(order.userId);
          }
        }
      }
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    return NextResponse.json({ error: "Webhook error" }, { status: 400 });
  }
}
