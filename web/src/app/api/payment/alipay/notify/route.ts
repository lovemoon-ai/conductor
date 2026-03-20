import { NextRequest, NextResponse } from "next/server";
import { getAlipay } from "@/lib/payment/alipay";
import { db } from "@/lib/db";
import { renewPlusSubscription } from "@/lib/subscription/service";

export async function POST(request: NextRequest) {
  const alipay = await getAlipay();
  if (!alipay) {
    return NextResponse.json({ error: "Alipay not configured" }, { status: 500 });
  }

  const formData = await request.formData();
  const params: Record<string, string> = {};
  formData.forEach((value, key) => {
    params[key] = value.toString();
  });

  const orderId = params.out_trade_no;
  const tradeStatus = params.trade_status;
  let signValid = false;
  try {
    signValid =
      (typeof alipay.checkNotifySign === "function" && alipay.checkNotifySign(params)) ||
      (typeof alipay.checkNotifySignV2 === "function" && alipay.checkNotifySignV2(params));
  } catch (error) {
    console.error("Failed to verify Alipay signature:", error);
  }

  if (!signValid) {
    console.warn("Invalid Alipay notify signature", { orderId });
    return new NextResponse("failure", { headers: { "Content-Type": "text/plain" } });
  }

  if (!orderId) {
    return new NextResponse("failure", { headers: { "Content-Type": "text/plain" } });
  }

  if (tradeStatus !== "TRADE_SUCCESS" && tradeStatus !== "TRADE_FINISHED") {
    return new NextResponse("success", { headers: { "Content-Type": "text/plain" } });
  }

  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) {
    return new NextResponse("failure", { headers: { "Content-Type": "text/plain" } });
  }

  if (order.status !== "COMPLETED") {
    const totalAmount = Number(params.total_amount || "0");
    const totalCents = Math.round(totalAmount * 100);
    if (Number.isFinite(totalCents) && totalCents > 0 && totalCents !== order.amount) {
      console.warn("Alipay amount mismatch", { orderId, totalCents, expected: order.amount });
      return new NextResponse("failure", { headers: { "Content-Type": "text/plain" } });
    }

    await db.order.update({
      where: { id: orderId },
      data: { status: "COMPLETED", providerOrderId: params.trade_no },
    });
  }

  let metadata: any = {};
  try {
    metadata = order.metadata ? JSON.parse(order.metadata) : {};
  } catch (e) {
    console.error("Failed to parse order metadata:", e);
  }

  if (metadata.type === "subscription" && metadata.tier === "PLUS") {
    await renewPlusSubscription(order.userId);
    console.log(`Activated Plus subscription for user ${order.userId}`);
  }

  return new NextResponse("success", { headers: { "Content-Type": "text/plain" } });
}
