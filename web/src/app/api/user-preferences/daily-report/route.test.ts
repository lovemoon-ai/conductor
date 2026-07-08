import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import { GET, PATCH } from "./route";

vi.mock("@/lib/auth/middleware", () => ({
  getAuthUser: vi.fn(),
}));

vi.mock("@/lib/daily-reports/client-timezone", () => ({
  resolveClientTimezone: vi.fn(),
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    broadcastToUser: vi.fn(),
  },
}));

vi.mock("@/lib/daily-reports/daily-report", async () => {
  class MockDailyReportInputError extends Error {
    status: number;
    details: Record<string, unknown>;

    constructor(message: string, status = 400, details?: Record<string, unknown>) {
      super(message);
      this.status = status;
      this.details = details ?? { error: message };
    }
  }
  class MockDailyReportSchemaUnavailableError extends Error {
    constructor() {
      super("Daily reports are unavailable until the database schema is updated. Run 'pnpm -C web db:push'.");
    }
  }
  return {
    DailyReportInputError: MockDailyReportInputError,
    DailyReportSchemaUnavailableError: MockDailyReportSchemaUnavailableError,
    getDailyReportSetting: vi.fn(),
    updateDailyReportSetting: vi.fn(),
  };
});

const { getAuthUser } = await import("@/lib/auth/middleware");
const { resolveClientTimezone } = await import("@/lib/daily-reports/client-timezone");
const { realtimeHub } = await import("@/lib/realtime/hub");
const {
  getDailyReportSetting,
  updateDailyReportSetting,
} = await import("@/lib/daily-reports/daily-report");

const makeSetting = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  timezone: "Europe/London",
  sendTimeLocal: "20:00",
  send_time_local: "20:00",
  deliveryChannels: ["in_app"],
  delivery_channels: ["in_app"],
  nextRunAt: "2026-07-01T19:00:00.000Z",
  next_run_at: "2026-07-01T19:00:00.000Z",
  lastSentForDate: null,
  last_sent_for_date: null,
  lastRunAt: null,
  last_run_at: null,
  lastError: null,
  last_error: null,
  ...overrides,
});

describe("/api/user-preferences/daily-report", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
    vi.mocked(resolveClientTimezone).mockResolvedValue("Europe/London");
    vi.mocked(getDailyReportSetting).mockResolvedValue(makeSetting() as any);
    vi.mocked(updateDailyReportSetting).mockResolvedValue(makeSetting() as any);
  });

  it("returns the stored daily report setting", async () => {
    const response = await GET(createMockRequest({ token: createTestToken("user-1") }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.sendTimeLocal).toBe("20:00");
    expect(getDailyReportSetting).toHaveBeenCalledWith("user-1");
  });

  it("uses server-resolved timezone and fixed schedule inputs on update", async () => {
    const request = createMockRequest({
      method: "PATCH",
      token: createTestToken("user-1"),
      body: {
        enabled: true,
        timezone: "America/New_York",
        sendTimeLocal: "09:30",
        deliveryChannels: ["in_app"],
      },
    });

    const response = await PATCH(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.timezone).toBe("Europe/London");
    expect(resolveClientTimezone).toHaveBeenCalledWith(request);
    expect(updateDailyReportSetting).toHaveBeenCalledWith({
      userId: "user-1",
      enabled: true,
      timezone: "Europe/London",
      deliveryChannels: ["in_app"],
    });
    expect(realtimeHub.broadcastToUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ type: "daily_report_setting_update" }),
    );
  });

  it("does not lookup timezone when disabling daily reports", async () => {
    const response = await PATCH(
      createMockRequest({
        method: "PATCH",
        token: createTestToken("user-1"),
        body: { enabled: false, deliveryChannels: ["in_app"] },
      }),
    );

    expect(response.status).toBe(200);
    expect(resolveClientTimezone).not.toHaveBeenCalled();
    expect(updateDailyReportSetting).toHaveBeenCalledWith({
      userId: "user-1",
      enabled: false,
      timezone: undefined,
      deliveryChannels: ["in_app"],
    });
  });
});
