import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "@/app/api/payment/alipay/notify/route";

vi.mock("@/lib/payment/alipay", () => ({
  getAlipay: vi.fn(),
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

const { getAlipay } = await import("@/lib/payment/alipay");
const { renewPlusSubscription } = await import("@/lib/subscription/service");
const { db } = await import("@/lib/db");

const createNotifyRequest = (params: Record<string, string>) =>
  ({
    formData: async () => {
      const data = new FormData();
      Object.entries(params).forEach(([key, value]) => data.append(key, value));
      return data;
    },
  } as any);

describe("/api/payment/alipay/notify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return failure when signature is invalid", async () => {
    vi.mocked(getAlipay).mockResolvedValue({
      checkNotifySign: vi.fn().mockReturnValue(false),
    } as any);

    const request = createNotifyRequest({
      out_trade_no: "order-1",
      trade_status: "TRADE_SUCCESS",
      total_amount: "49.00",
      trade_no: "ali-1",
    });

    const response = await POST(request);
    const text = await response.text();

    expect(text).toBe("failure");
    expect(db.order.findUnique).not.toHaveBeenCalled();
  });

  it("should complete order and renew subscription on success", async () => {
    vi.mocked(getAlipay).mockResolvedValue({
      checkNotifySign: vi.fn().mockReturnValue(true),
    } as any);

    vi.mocked(db.order.findUnique).mockResolvedValue({
      id: "order-1",
      userId: "user-1",
      amount: 4900,
      status: "PENDING",
      metadata: JSON.stringify({ type: "subscription", tier: "PLUS" }),
    } as any);

    vi.mocked(db.order.update).mockResolvedValue({
      id: "order-1",
      status: "COMPLETED",
    } as any);

    const request = createNotifyRequest({
      out_trade_no: "order-1",
      trade_status: "TRADE_SUCCESS",
      total_amount: "49.00",
      trade_no: "ali-1",
    });

    const response = await POST(request);
    const text = await response.text();

    expect(text).toBe("success");
    expect(db.order.update).toHaveBeenCalled();
    expect(renewPlusSubscription).toHaveBeenCalledWith("user-1");
  });
});
