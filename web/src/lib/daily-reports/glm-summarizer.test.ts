import { afterEach, describe, expect, it, vi } from "vitest";

import type { DailyReportPayload } from "./daily-report";
import { summarizeDailyReportWithGlm } from "./glm-summarizer";

const makePayload = (): DailyReportPayload => ({
  reportDate: "2026-07-01",
  report_date: "2026-07-01",
  timezone: "Asia/Shanghai",
  generatedAt: "2026-07-01T10:00:00.000Z",
  generated_at: "2026-07-01T10:00:00.000Z",
  rangeStart: "2026-06-30T16:00:00.000Z",
  range_start: "2026-06-30T16:00:00.000Z",
  rangeEnd: "2026-07-01T16:00:00.000Z",
  range_end: "2026-07-01T16:00:00.000Z",
  totals: {
    projects: 1,
    tasks: 1,
    messages: 2,
    completed: 1,
    running: 0,
    killed: 0,
  },
  projects: [
    {
      projectId: "project-1",
      project_id: "project-1",
      projectName: "Conductor",
      project_name: "Conductor",
      daemonHost: "daemon-a",
      daemon_host: "daemon-a",
      summary: "1 task touched, 2 messages, 1 completed.",
      stats: {
        tasksTouched: 1,
        tasks_touched: 1,
        messages: 2,
        completed: 1,
        running: 0,
        killed: 0,
      },
      timeline: [
        {
          taskId: "task-1",
          task_id: "task-1",
          taskTitle: "Ship daily reports",
          task_title: "Ship daily reports",
          issueTitle: "Daily summary",
          issue_title: "Daily summary",
          status: "completed",
          startAt: "2026-07-01T01:00:00.000Z",
          start_at: "2026-07-01T01:00:00.000Z",
          endAt: "2026-07-01T03:00:00.000Z",
          end_at: "2026-07-01T03:00:00.000Z",
          timeRange: "09:00-11:00",
          time_range: "09:00-11:00",
          summary: "2 messages; status completed; latest: Done",
          events: [
            {
              type: "message",
              timestamp: "2026-07-01T01:10:00.000Z",
              time: "09:10",
              title: "User message",
              detail: "Add the report",
              role: "user",
            },
          ],
        },
      ],
    },
  ],
});

describe("GLM daily report summarizer", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips GLM when the API key is missing", async () => {
    vi.stubEnv("GLM_API_KEY", "");
    const fetchSpy = vi.fn();

    const result = await summarizeDailyReportWithGlm({
      payload: makePayload(),
      fallbackSummaryMarkdown: "# Rule summary",
      fetchImpl: fetchSpy as any,
    });

    expect(result.summaryMarkdown).toBe("# Rule summary");
    expect(result.summarizer).toMatchObject({
      provider: "rules",
      model: null,
      status: "missing_api_key",
      error: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls the GLM chat completions endpoint and returns markdown", async () => {
    vi.stubEnv("GLM_API_KEY", "glm-test");
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "# 每日总结\n\n完成日报功能。" } }],
        }),
        { status: 200 },
      ),
    );

    const result = await summarizeDailyReportWithGlm({
      payload: makePayload(),
      fallbackSummaryMarkdown: "# Rule summary",
      fetchImpl: fetchSpy as any,
    });

    expect(result.summaryMarkdown).toContain("完成日报功能");
    expect(result.summarizer).toMatchObject({
      provider: "glm",
      model: "glm-5.2",
      status: "success",
      error: null,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer glm-test",
        }),
      }),
    );

    const requestBody = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
    expect(requestBody).toMatchObject({
      model: "glm-5.2",
      stream: false,
      thinking: { type: "disabled" },
      do_sample: false,
      max_tokens: 4096,
    });
    expect(requestBody.messages[0]).toMatchObject({ role: "system" });
    expect(requestBody.messages[1].content).toContain("Ship daily reports");

    const systemPrompt = String(requestBody.messages[0].content);
    expect(systemPrompt).toContain("当前用户");
    expect(systemPrompt).toContain("不要使用本地仓库上下文");
    expect(systemPrompt).toContain("不要写产物");
    expect(systemPrompt).toContain("任务时间线");
    expect(systemPrompt).toContain("为什么做这些事");
    expect(systemPrompt).not.toContain("保留当天时间轴");

    const promptPayload = JSON.parse(String(requestBody.messages[1].content));
    expect(promptPayload).not.toHaveProperty("existingRuleSummary");
    expect(promptPayload).toMatchObject({
      fallbackSummaryAvailable: true,
      outputTemplate: expect.arrayContaining([
        "# 每日复盘 - YYYY-MM-DD",
        "## 1. 今日主线判断",
        "## 2. 项目复盘",
        "## 3. 注意力评估",
        "## 4. 明日聚焦",
      ]),
    });
    expect(promptPayload.reportData.source).toMatchObject({
      description: expect.stringContaining("当前用户"),
      includes: expect.arrayContaining(["user messages", "AI messages", "task status events"]),
    });
    expect(promptPayload.reportData.projects[0].taskEvidence[0]).toMatchObject({
      taskTitle: "Ship daily reports",
      issueTitle: "Daily summary",
      status: "completed",
      activitySummary: "2 messages; status completed; latest: Done",
      activityMessages: [
        expect.objectContaining({
          time: "09:10",
          kind: "user_message",
          text: "Add the report",
          role: "user",
        }),
      ],
    });
    expect(promptPayload.reportData.projects[0]).not.toHaveProperty("timeline");
    expect(promptPayload.reportData.projects[0].taskEvidence[0]).not.toHaveProperty("timeRange");
    expect(promptPayload.reportData.projects[0].taskEvidence[0].activityMessages[0]).not.toHaveProperty("title");
    expect(String(requestBody.messages[1].content)).not.toContain("# Rule summary");
  });

  it("falls back to the rule summary when GLM fails", async () => {
    vi.stubEnv("GLM_API_KEY", "glm-test");
    const fetchSpy = vi.fn().mockResolvedValue(new Response("upstream down", { status: 503 }));

    const result = await summarizeDailyReportWithGlm({
      payload: makePayload(),
      fallbackSummaryMarkdown: "# Rule summary",
      fetchImpl: fetchSpy as any,
    });

    expect(result.summaryMarkdown).toBe("# Rule summary");
    expect(result.summarizer).toMatchObject({
      provider: "rules",
      status: "fallback",
    });
    expect(result.summarizer.error).toContain("HTTP 503");
  });
});
