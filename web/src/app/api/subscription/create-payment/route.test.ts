import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "@/app/api/subscription/create-payment/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/payment/alipay", () => ({
  getAlipay: vi.fn(),
}));

vi.mock("@/lib/payment/stripe", () => ({
  stripe: {
    checkout: {
      sessions: {
        create: vi.fn(),
      },
    },
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    order: {
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const { getAlipay } = await import("@/lib/payment/alipay");
const { stripe } = await import("@/lib/payment/stripe");
const { db } = await import("@/lib/db");
const stripeMock = stripe as NonNullable<typeof stripe>;

describe("/api/subscription/create-payment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create Alipay payment order by default", async () => {
    const mockUser = { id: "user-1", email: "test@example.com", phone: null };
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

    vi.mocked(getAlipay).mockResolvedValue({
      pageExecute: vi.fn().mockResolvedValue("<form></form>"),
    } as any);

    vi.mocked(db.order.create).mockResolvedValue({
      id: "order-1",
    } as any);

    const token = createTestToken("user-1");
    const request = createMockRequest({ method: "POST", token });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.orderId).toBe("order-1");
    expect(data.paymentUrl).toBe("<form></form>");
  });

  it("should create Stripe payment order when provider is STRIPE", async () => {
    const mockUser = { id: "user-1", email: "test@example.com", phone: null };
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

    vi.mocked(stripeMock.checkout.sessions.create).mockResolvedValue({
      id: "cs_test",
      url: "https://stripe.test/checkout",
    } as any);

    vi.mocked(db.order.create).mockResolvedValue({
      id: "order-2",
    } as any);

    const token = createTestToken("user-1");
    const request = createMockRequest({
      method: "POST",
      token,
      body: { provider: "STRIPE" },
    });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.orderId).toBe("order-2");
    expect(data.paymentUrl).toBe("https://stripe.test/checkout");
    expect(db.order.update).toHaveBeenCalledWith({
      where: { id: "order-2" },
      data: { providerOrderId: "cs_test" },
    });
  });
});
