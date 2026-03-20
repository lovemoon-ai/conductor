import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

const { mockGetPublicDeviceAuthorization } = vi.hoisted(() => ({
  mockGetPublicDeviceAuthorization: vi.fn(),
}));

vi.mock("@/lib/auth/device-auth", () => ({
  getPublicDeviceAuthorization: mockGetPublicDeviceAuthorization,
}));

describe("/api/auth/device/session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when user_code is missing", async () => {
    const { GET } = await import("./route");
    const response = await GET(createMockRequest({ method: "GET", url: "http://localhost:6152/api/auth/device/session" }));
    const data = await extractJson(response);

    expect(response.status).toBe(400);
    expect(data.error).toBe("user_code is required");
  });

  it("returns public device authorization details", async () => {
    mockGetPublicDeviceAuthorization.mockResolvedValue({
      status: "pending",
      userCode: "ABCD-EFGH",
      cliVersion: "0.2.20",
      hostname: "mac-studio",
      platform: "darwin",
      backendUrl: "https://conductor-ai.top",
      expiresAt: "2026-03-19T10:00:00.000Z",
      approvedAt: null,
    });

    const { GET } = await import("./route");
    const response = await GET(
      createMockRequest({
        method: "GET",
        url: "http://localhost:6152/api/auth/device/session?user_code=ABCD-EFGH",
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.user_code).toBe("ABCD-EFGH");
    expect(data.hostname).toBe("mac-studio");
    expect(mockGetPublicDeviceAuthorization).toHaveBeenCalledWith("ABCD-EFGH");
  });
});
