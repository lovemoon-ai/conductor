import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

const { mockStartDeviceAuthorization } = vi.hoisted(() => ({
  mockStartDeviceAuthorization: vi.fn(),
}));

vi.mock("@/lib/auth/device-auth", () => ({
  DEVICE_AUTH_POLL_INTERVAL_SECONDS: 3,
  startDeviceAuthorization: mockStartDeviceAuthorization,
}));

describe("/api/auth/device/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartDeviceAuthorization.mockResolvedValue({
      deviceCode: "device-code-1",
      userCode: "ABCD-EFGH",
      expiresIn: 600,
      interval: 3,
    });
  });

  it("starts a device authorization session", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "https://conductor-ai.top/api/auth/device/start",
        headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
        body: { cli_version: "0.2.20", hostname: "mac-studio", platform: "darwin" },
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.user_code).toBe("ABCD-EFGH");
    expect(data.verification_uri).toBe("https://conductor.conductor-ai.top/activate");
    expect(data.verification_uri_complete).toBe(
      "https://conductor.conductor-ai.top/activate?user_code=ABCD-EFGH",
    );
    expect(mockStartDeviceAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedByIp: "1.2.3.4",
        cliVersion: "0.2.20",
        hostname: "mac-studio",
        platform: "darwin",
      }),
    );
  });

  it("keeps a self-hosted device authorization origin", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "https://conductor.example.com/api/auth/device/start",
        body: {},
      }),
    );
    const data = await extractJson(response);

    expect(data.verification_uri).toBe("https://conductor.example.com/activate");
    expect(data.verification_uri_complete).toBe(
      "https://conductor.example.com/activate?user_code=ABCD-EFGH",
    );
  });
});
