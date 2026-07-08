import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import { DailyReportInputError, DailyReportSchemaUnavailableError } from "@/lib/daily-reports/daily-report";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
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
    getDailyReport: vi.fn(),
    listDailyReportRuns: vi.fn(),
    persistDailyReport: vi.fn(),
  };
});

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const {
  getDailyReport,
  listDailyReportRuns,
  persistDailyReport,
} = await import("@/lib/daily-reports/daily-report");

const makeReport = (overrides: Record<string, unknown> = {}) => ({
  id: "report-1",
  userId: "user-1",
  user_id: "user-1",
  reportDate: "2026-07-01",
  report_date: "2026-07-01",
  timezone: "Asia/Shanghai",
  status: "preview",
  summaryMarkdown: "# Daily Report",
  summary_markdown: "# Daily Report",
  payload: {
    totals: { projects: 1, tasks: 1, messages: 2, completed: 1, running: 0, killed: 0 },
    projects: [],
  },
  deliveryChannels: ["in_app"],
  delivery_channels: ["in_app"],
  sentAt: null,
  sent_at: null,
  lastError: null,
  last_error: null,
  persisted: false,
  createdAt: null,
  created_at: null,
  updatedAt: null,
  updated_at: null,
  ...overrides,
});

describe("/api/daily-reports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    } as any);
    vi.mocked(getDailyReport).mockResolvedValue(makeReport() as any);
    vi.mocked(persistDailyReport).mockResolvedValue(makeReport({ persisted: true }) as any);
    vi.mocked(listDailyReportRuns).mockResolvedValue([makeReport({ persisted: true })] as any);
  });

  it("returns a report preview for the requested date", async () => {
    const response = await GET(
      createMockRequest({
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/daily-reports?date=2026-07-01&timezone=Asia%2FShanghai",
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.reportDate).toBe("2026-07-01");
    expect(getDailyReport).toHaveBeenCalledWith({
      userId: "user-1",
      reportDate: "2026-07-01",
      timezone: "Asia/Shanghai",
    });
  });

  it("lists persisted report runs", async () => {
    const response = await GET(
      createMockRequest({
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/daily-reports?list=1&limit=7",
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.reports).toHaveLength(1);
    expect(listDailyReportRuns).toHaveBeenCalledWith({ userId: "user-1", limit: 7 });
  });

  it("persists a generated report", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/daily-reports",
        body: { reportDate: "2026-07-01", timezone: "Asia/Shanghai" },
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.persisted).toBe(true);
    expect(persistDailyReport).toHaveBeenCalledWith({
      userId: "user-1",
      reportDate: "2026-07-01",
      timezone: "Asia/Shanghai",
      status: "generated",
    });
  });

  it("returns validation errors from report generation", async () => {
    vi.mocked(getDailyReport).mockRejectedValueOnce(
      new DailyReportInputError("reportDate must use YYYY-MM-DD", 400, {
        error: "reportDate must use YYYY-MM-DD",
      }),
    );

    const response = await GET(
      createMockRequest({
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/daily-reports?date=bad",
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(400);
    expect(data.error).toBe("reportDate must use YYYY-MM-DD");
  });

  it("returns 409 when persistence schema is unavailable", async () => {
    vi.mocked(persistDailyReport).mockRejectedValueOnce(new DailyReportSchemaUnavailableError());

    const response = await POST(
      createMockRequest({
        method: "POST",
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/daily-reports",
        body: { reportDate: "2026-07-01" },
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("Daily reports are unavailable");
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getActiveSubscriptionUser).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const response = await GET(
      createMockRequest({
        token: createTestToken("user-1"),
        url: "http://localhost:6152/api/daily-reports",
      }),
    );
    const data = await extractJson(response);

    expect(response.status).toBe(401);
    expect(data.error).toBe("Unauthorized");
  });
});
