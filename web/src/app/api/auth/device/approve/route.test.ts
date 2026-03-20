import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

const { mockApproveDeviceAuthorization } = vi.hoisted(() => ({
  mockApproveDeviceAuthorization: vi.fn(),
}));

vi.mock("@/lib/auth/device-auth", () => ({
  approveDeviceAuthorization: mockApproveDeviceAuthorization,
}));

vi.mock("@/lib/auth/middleware", () => ({
  getAuthUser: vi.fn(),
}));

const { getAuthUser } = await import("@/lib/auth/middleware");

describe("/api/auth/device/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const { POST } = await import("./route");
    const response = await POST(createMockRequest({ method: "POST", body: { user_code: "ABCD-EFGH" } }));
    const data = await extractJson(response);

    expect(response.status).toBe(401);
    expect(data.error).toBe("Unauthorized");
  });

  it("approves a device authorization for the current user", async () => {
    const { POST } = await import("./route");
    const response = await POST(createMockRequest({ method: "POST", body: { user_code: "ABCD-EFGH" } }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(mockApproveDeviceAuthorization).toHaveBeenCalledWith("ABCD-EFGH", "user-1");
  });
});
