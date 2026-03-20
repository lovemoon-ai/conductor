import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/payment/stripe/webhook/route";

vi.mock("@/lib/payment/stripe", () => ({
  stripe: {
    webhooks: {
      constructEvent: vi.fn(),
    },
  },
}));

vi.mock("@/lib/subscription/service", () => ({
  renewPlusSubscription: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    order: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const { stripe } = await import("@/lib/payment/stripe");
const { renewPlusSubscription } = await import("@/lib/subscription/service");
const { db } = await import("@/lib/db");
const stripeMock = stripe as NonNullable<typeof stripe>;

describe("/api/payment/stripe/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  it("should complete order and renew subscription on checkout.session.completed", async () => {
    vi.mocked(stripeMock.webhooks.constructEvent).mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test",
          metadata: { orderId: "order-1" },
        },
      },
    } as any);

    vi.mocked(db.order.findUnique).mockResolvedValue({
      id: "order-1",
      userId: "user-1",
      status: "PENDING",
      metadata: JSON.stringify({ type: "subscription", tier: "PLUS" }),
    } as any);

    const request = new NextRequest("http://localhost:6152/api/payment/stripe/webhook", {
      method: "POST",
      headers: {
        "stripe-signature": "sig_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "evt_test" }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.received).toBe(true);
    expect(db.order.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { status: "COMPLETED", providerOrderId: "cs_test" },
    });
    expect(renewPlusSubscription).toHaveBeenCalledWith("user-1");
  });
});
