import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST, resolveAgentWebsocketUrl } from "./route";
import { createMockRequest } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getAuthUser: vi.fn(),
}));

vi.mock("@/lib/auth/service", () => ({
  getLatestTokenValue: vi.fn(),
  issueApiToken: vi.fn(),
}));

vi.mock("@/lib/channel/provider-config", () => ({
  getFeishuProviderConfigForUser: vi.fn(),
}));

const { getAuthUser } = await import("@/lib/auth/middleware");
const { getLatestTokenValue, issueApiToken } = await import("@/lib/auth/service");
const { getFeishuProviderConfigForUser } = await import("@/lib/channel/provider-config");

describe("/api/auth/config", () => {
  const originalBackendUrl = process.env.PUBLIC_BACKEND_URL;
  const originalAgentWsUrl = process.env.PUBLIC_AGENT_WS_URL;
  const originalWsUrl = process.env.PUBLIC_WS_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
    vi.mocked(getLatestTokenValue).mockResolvedValue("token-1");
    vi.mocked(issueApiToken).mockResolvedValue({ token: "issued-token-1" } as any);
    vi.mocked(getFeishuProviderConfigForUser).mockResolvedValue(null);
    process.env.PUBLIC_BACKEND_URL = "https://app.conductor-ai.top";
    delete process.env.PUBLIC_AGENT_WS_URL;
    delete process.env.PUBLIC_WS_URL;
  });

  afterEach(() => {
    if (originalBackendUrl === undefined) {
      delete process.env.PUBLIC_BACKEND_URL;
    } else {
      process.env.PUBLIC_BACKEND_URL = originalBackendUrl;
    }
    if (originalAgentWsUrl === undefined) {
      delete process.env.PUBLIC_AGENT_WS_URL;
    } else {
      process.env.PUBLIC_AGENT_WS_URL = originalAgentWsUrl;
    }
    if (originalWsUrl === undefined) {
      delete process.env.PUBLIC_WS_URL;
    } else {
      process.env.PUBLIC_WS_URL = originalWsUrl;
    }
  });

  it("prefers PUBLIC_AGENT_WS_URL for daemon config", async () => {
    process.env.PUBLIC_AGENT_WS_URL = "https://ws.conductor-ai.top";

    const response = await POST(createMockRequest({ method: "POST" }));
    const yaml = await response.text();

    expect(response.status).toBe(200);
    expect(yaml).toContain('websocket_url: "wss://ws.conductor-ai.top/ws/agent"');
  });

  it("derives agent websocket url from backend url when no override is configured", () => {
    expect(resolveAgentWebsocketUrl("https://app.conductor-ai.top")).toBe(
      "wss://app.conductor-ai.top/ws/agent",
    );
  });
});
