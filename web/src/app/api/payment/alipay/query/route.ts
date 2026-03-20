import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import { getAlipay } from "@/lib/payment/alipay";
import { db } from "@/lib/db";
import { renewPlusSubscription } from "@/lib/subscription/service";

export async function POST(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const alipay = await getAlipay();
  if (!alipay) {
    return NextResponse.json({ error: "Alipay not configured" }, { status: 500 });
  }

  const body = await request.json();
  const orderId = body.orderId;

  if (!orderId) {
    return NextResponse.json({ error: "Order ID required" }, { status: 400 });
  }

  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  if (order.userId !== user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // If order is already completed, return success
  if (order.status === "COMPLETED") {
    return NextResponse.json({ status: "COMPLETED", message: "Order already completed" });
  }

  try {
    const result = await alipay.exec("alipay.trade.query", {
      bizContent: {
        out_trade_no: orderId,
      },
    });

    const tradeStatus = result?.tradeStatus;

    if (tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED") {
      // Update order status
      await db.order.update({
        where: { id: orderId },
        data: { status: "COMPLETED", providerOrderId: result?.tradeNo },
      });

      // Parse metadata and activate subscription if applicable
      let metadata: Record<string, unknown> = {};
      try {
        metadata = order.metadata ? JSON.parse(order.metadata) : {};
      } catch {
        console.error("Failed to parse order metadata");
      }

      if (metadata.type === "subscription" && metadata.tier === "PLUS") {
        await renewPlusSubscription(order.userId);
        console.log(`Activated Plus subscription for user ${order.userId} via query`);
      }

      return NextResponse.json({ status: "COMPLETED", message: "Payment confirmed" });
    }

    return NextResponse.json({ status: tradeStatus || "PENDING", message: "Payment not completed" });
  } catch (error) {
    console.error("Failed to query Alipay order:", error);
    return NextResponse.json({ error: "Failed to query order status" }, { status: 500 });
  }
}
