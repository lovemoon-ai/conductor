import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

const mockVerificationCreate = vi.fn().mockResolvedValue({ id: "verification-id" });
const mockSendSms = vi.fn().mockResolvedValue(undefined);
const mockSendEmail = vi.fn().mockResolvedValue(undefined);

function getTestPhone(): string {
  const configuredPhone = process.env.CONDUCTOR_PHONE?.trim() || "13000000000";
  const compactPhone = configuredPhone.replace(/[\s()-]/g, "");
  if (compactPhone.startsWith("+86")) return compactPhone.slice(3);
  if (compactPhone.startsWith("86") && compactPhone.length > 11) return compactPhone.slice(2);
  return compactPhone;
}

const TEST_PHONE = getTestPhone();

vi.mock("@/lib/db", () => ({
  db: {
    verification: {
      create: mockVerificationCreate,
    },
  },
}));

vi.mock("@/lib/verification/volc-sms", () => ({
  sendVerificationSms: mockSendSms,
}));

vi.mock("@/lib/verification/resend-email", () => ({
  sendVerificationEmail: mockSendEmail,
}));

describe("/api/auth/request-code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when both email and phone are missing", async () => {
    const { POST } = await import("./route");
    const request = createMockRequest({ method: "POST", body: {} });

    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(400);
    expect(data.error).toBe("Email or phone required");
  });

  it("stores full overseas number and forwards countryCode to sms sender", async () => {
    const { POST } = await import("./route");
    const request = createMockRequest({
      method: "POST",
      body: { phone: TEST_PHONE, countryCode: "+1" },
    });

    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.expiresIn).toBe(300);

    expect(mockVerificationCreate).toHaveBeenCalledTimes(1);
    expect(mockVerificationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          target: `+1${TEST_PHONE}`,
          type: "SMS",
        }),
      }),
    );

    expect(mockSendSms).toHaveBeenCalledTimes(1);
    expect(mockSendSms).toHaveBeenCalledWith(TEST_PHONE, expect.any(String), "+1");
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
