import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

const { mockVerificationCreate, mockSendVerificationSms } = vi.hoisted(() => ({
  mockVerificationCreate: vi.fn().mockResolvedValue({ id: "test-id" }),
  mockSendVerificationSms: vi.fn().mockResolvedValue(undefined),
}));

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
  sendVerificationSms: mockSendVerificationSms,
}));

describe("/api/verification/send-sms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return 400 if phone is missing", async () => {
    const request = createMockRequest({ method: "POST", body: {} });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(400);
    expect(data.error).toBe("Phone required");
  });

  it("should return success when phone is provided", async () => {
    const request = createMockRequest({ method: "POST", body: { phone: TEST_PHONE } });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.expiresIn).toBe(300);
    expect(mockVerificationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          target: `+86${TEST_PHONE}`,
          type: "SMS",
        }),
      }),
    );
    expect(mockSendVerificationSms).toHaveBeenCalledWith(TEST_PHONE, expect.any(String), "+86");
  });

  it("should trim phone number", async () => {
    const request = createMockRequest({ method: "POST", body: { phone: `  ${TEST_PHONE}  ` } });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
  });

  it("should support overseas country codes", async () => {
    const request = createMockRequest({
      method: "POST",
      body: { phone: TEST_PHONE, countryCode: "+1" },
    });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(mockVerificationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          target: `+1${TEST_PHONE}`,
        }),
      }),
    );
    expect(mockSendVerificationSms).toHaveBeenCalledWith(TEST_PHONE, expect.any(String), "+1");
  });
});
