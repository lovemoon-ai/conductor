import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

const { mockPollDeviceAuthorization } = vi.hoisted(() => ({
  mockPollDeviceAuthorization: vi.fn(),
}));

vi.mock("@/lib/auth/device-auth", () => ({
  pollDeviceAuthorization: mockPollDeviceAuthorization,
}));

describe("/api/auth/device/poll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when device_code is missing", async () => {
    const { POST } = await import("./route");
    const response = await POST(createMockRequest({ method: "POST", body: {} }));
    const data = await extractJson(response);

    expect(response.status).toBe(400);
    expect(data.error).toBe("device_code is required");
  });

  it("returns approved payload with backend and websocket urls", async () => {
    mockPollDeviceAuthorization.mockResolvedValue({
      status: "approved",
      agentToken: "token-1",
    });

    const { POST } = await import("./route");
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "https://conductor-ai.top/api/auth/device/poll",
        body: { device_code: "device-1" },
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.status).toBe("approved");
    expect(data.agent_token).toBe("token-1");
    expect(data.backend_url).toBe("https://conductor-ai.top");
    expect(data.websocket_url).toBe("wss://conductor-ai.top/ws/agent");
  });
});
