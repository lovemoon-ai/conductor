import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    task: {
      findMany: vi.fn(),
    },
    dailyReportSetting: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
    dailyReportRun: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    broadcastToUser: vi.fn(),
  },
}));

vi.mock("./glm-summarizer", () => ({
  summarizeDailyReportWithGlm: vi.fn(async ({ payload, fallbackSummaryMarkdown }: any) => ({
    summaryMarkdown: fallbackSummaryMarkdown,
    summarizer: {
      provider: "rules",
      model: null,
      status: "missing_api_key",
      generatedAt: payload.generatedAt,
      generated_at: payload.generated_at,
      error: null,
    },
  })),
}));

const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { summarizeDailyReportWithGlm } = await import("./glm-summarizer");
const {
  computeNextRunAt,
  generateDailyReport,
  processDueDailyReports,
  reconcileDailyReportSchedules,
  updateDailyReportSetting,
} = await import("./daily-report");

const date = (value: string) => new Date(value);

const settingRow = {
  id: "setting-1",
  userId: "user-1",
  enabled: true,
  timezone: "Asia/Shanghai",
  sendTimeLocal: "20:00",
  deliveryChannels: JSON.stringify(["in_app"]),
  nextRunAt: date("2026-07-01T12:00:00.000Z"),
  lastSentForDate: null,
  lastRunAt: null,
  lastError: null,
  createdAt: date("2026-07-01T00:00:00.000Z"),
  updatedAt: date("2026-07-01T00:00:00.000Z"),
};

describe("daily reports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(summarizeDailyReportWithGlm).mockImplementation(
      async ({ payload, fallbackSummaryMarkdown }: any) => ({
        summaryMarkdown: fallbackSummaryMarkdown,
        summarizer: {
          provider: "rules",
          model: null,
          status: "missing_api_key",
          generatedAt: payload.generatedAt,
          generated_at: payload.generated_at,
          error: null,
        },
      }),
    );
    vi.mocked(db.task.findMany).mockResolvedValue([]);
    vi.mocked(db.dailyReportSetting.findUnique).mockResolvedValue(settingRow as any);
    vi.mocked(db.dailyReportSetting.findMany).mockResolvedValue([]);
    vi.mocked(db.dailyReportSetting.update).mockResolvedValue({} as any);
    vi.mocked(db.dailyReportSetting.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.dailyReportRun.findUnique).mockResolvedValue(null);
    vi.mocked(db.dailyReportRun.findMany).mockResolvedValue([]);
    (db.dailyReportRun.upsert as any).mockImplementation(async ({ create, update }: any) => ({
      id: "report-1",
      userId: create?.userId ?? "user-1",
      reportDate: create?.reportDate ?? update?.reportDate ?? "2026-07-01",
      timezone: create?.timezone ?? update?.timezone ?? "Asia/Shanghai",
      status: create?.status ?? update?.status ?? "generated",
      summaryMarkdown: create?.summaryMarkdown ?? update?.summaryMarkdown ?? "",
      payloadJson: create?.payloadJson ?? update?.payloadJson ?? "{}",
      deliveryChannels: create?.deliveryChannels ?? update?.deliveryChannels ?? JSON.stringify(["in_app"]),
      sentAt: create?.sentAt ?? update?.sentAt ?? null,
      lastError: null,
      createdAt: date("2026-07-01T10:00:00.000Z"),
      updatedAt: date("2026-07-01T10:00:00.000Z"),
    }) as any);
  });

  it("computes the next local send time in UTC", () => {
    expect(
      computeNextRunAt({
        timezone: "Asia/Shanghai",
        sendTimeLocal: "20:00",
        now: date("2026-07-01T11:00:00.000Z"),
      }).toISOString(),
    ).toBe("2026-07-01T12:00:00.000Z");

    expect(
      computeNextRunAt({
        timezone: "Asia/Shanghai",
        sendTimeLocal: "20:00",
        now: date("2026-07-01T12:00:00.000Z"),
      }).toISOString(),
    ).toBe("2026-07-02T12:00:00.000Z");
  });

  it("stores the fixed 20:00 send time when updating settings", async () => {
    vi.mocked(db.dailyReportSetting.findUnique).mockResolvedValue({
      ...settingRow,
      sendTimeLocal: "18:00",
    } as any);
    vi.mocked(db.dailyReportSetting.upsert).mockResolvedValue({
      ...settingRow,
      sendTimeLocal: "20:00",
      nextRunAt: date("2026-07-01T12:00:00.000Z"),
      updatedAt: date("2026-07-01T09:00:00.000Z"),
    } as any);

    const setting = await updateDailyReportSetting({
      userId: "user-1",
      enabled: true,
      timezone: "Asia/Shanghai",
      now: date("2026-07-01T09:00:00.000Z"),
    });

    expect(setting.sendTimeLocal).toBe("20:00");
    expect(setting.nextRunAt).toBe("2026-07-01T12:00:00.000Z");
    expect(db.dailyReportSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          sendTimeLocal: "20:00",
          nextRunAt: date("2026-07-01T12:00:00.000Z"),
        }),
        update: expect.objectContaining({
          sendTimeLocal: "20:00",
          nextRunAt: date("2026-07-01T12:00:00.000Z"),
        }),
      }),
    );
  });

  it("groups touched tasks by project and builds task timelines", async () => {
    vi.mocked(db.task.findMany).mockResolvedValue([
      {
        id: "task-1",
        title: "Ship daily reports",
        status: "completed",
        createdAt: date("2026-07-01T01:00:00.000Z"),
        updatedAt: date("2026-07-01T03:00:00.000Z"),
        killedAt: null,
        project: { id: "project-1", name: "Conductor", daemonHost: "daemon-a" },
        issue: { title: "Daily summary" },
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "Add the report",
            createdAt: date("2026-07-01T01:10:00.000Z"),
          },
          {
            id: "msg-2",
            role: "assistant",
            content: "Implemented the report page",
            createdAt: date("2026-07-01T02:00:00.000Z"),
          },
        ],
        taskStatusEvents: [
          {
            id: "event-1",
            status: "completed",
            summary: "Done",
            createdAt: date("2026-07-01T03:00:00.000Z"),
          },
        ],
      },
    ] as any);

    const report = await generateDailyReport({
      userId: "user-1",
      reportDate: "2026-07-01",
      timezone: "Asia/Shanghai",
      now: date("2026-07-01T04:00:00.000Z"),
    });

    expect(report.payload.totals).toMatchObject({
      projects: 1,
      tasks: 1,
      messages: 2,
      completed: 1,
    });
    expect(report.payload.projects[0].projectName).toBe("Conductor");
    expect(report.payload.projects[0].timeline[0]).toMatchObject({
      taskTitle: "Ship daily reports",
      issueTitle: "Daily summary",
      timeRange: "09:00-11:00",
    });
    expect(report.payload.summarizer).toMatchObject({
      provider: "rules",
      status: "not_requested",
    });
    expect(report.summaryMarkdown).toContain("## Conductor");
    expect(summarizeDailyReportWithGlm).not.toHaveBeenCalled();
  });

  it("uses GLM summarization when requested", async () => {
    vi.mocked(summarizeDailyReportWithGlm).mockResolvedValueOnce({
      summaryMarkdown: "# AI summary",
      summarizer: {
        provider: "glm",
        model: "glm-5.2",
        status: "success",
        generatedAt: "2026-07-01T04:00:00.000Z",
        generated_at: "2026-07-01T04:00:00.000Z",
        error: null,
      },
    } as any);

    const report = await generateDailyReport({
      userId: "user-1",
      reportDate: "2026-07-01",
      timezone: "Asia/Shanghai",
      now: date("2026-07-01T04:00:00.000Z"),
      useAiSummary: true,
    });

    expect(report.summaryMarkdown).toBe("# AI summary");
    expect(report.payload.summarizer).toMatchObject({
      provider: "glm",
      model: "glm-5.2",
      status: "success",
    });
    expect(summarizeDailyReportWithGlm).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ reportDate: "2026-07-01" }),
        fallbackSummaryMarkdown: expect.stringContaining("# Daily Report"),
      }),
    );
  });

  it("processes due settings, persists a sent report, and broadcasts readiness", async () => {
    vi.mocked(db.dailyReportSetting.findMany).mockResolvedValue([settingRow] as any);
    vi.mocked(db.task.findMany).mockResolvedValue([]);

    const stats = await processDueDailyReports({
      now: date("2026-07-01T12:00:00.000Z"),
    });

    expect(stats).toMatchObject({ scanned: 1, generated: 1, failed: 0 });
    expect(db.dailyReportRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: "user-1",
          reportDate: "2026-07-01",
          status: "sent",
          sentAt: date("2026-07-01T12:00:00.000Z"),
        }),
      }),
    );
    expect(realtimeHub.broadcastToUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        type: "daily_report_ready",
      }),
    );
  });

  it("reconciles old enabled settings to the fixed 20:00 schedule", async () => {
    vi.mocked(db.dailyReportSetting.findMany).mockResolvedValue([
      {
        ...settingRow,
        sendTimeLocal: "18:00",
        nextRunAt: date("2026-07-01T10:00:00.000Z"),
      },
    ] as any);

    const stats = await reconcileDailyReportSchedules({
      now: date("2026-07-01T09:00:00.000Z"),
    });

    expect(stats).toEqual({ scanned: 1, updated: 1, skipped: 0, failed: 0 });
    expect(db.dailyReportSetting.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          enabled: true,
          OR: [
            { sendTimeLocal: { not: "20:00" } },
            { nextRunAt: null },
          ],
        },
      }),
    );
    expect(db.dailyReportSetting.update).toHaveBeenCalledWith({
      where: { id: "setting-1" },
      data: {
        timezone: "Asia/Shanghai",
        sendTimeLocal: "20:00",
        nextRunAt: date("2026-07-01T12:00:00.000Z"),
        lastError: null,
      },
    });
  });
});
