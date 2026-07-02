import type {
  DailyReportPayload,
  DailyReportSummarizerMetadata,
} from "./daily-report";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

export type GlmDailyReportSummaryResult = {
  summaryMarkdown: string;
  summarizer: DailyReportSummarizerMetadata;
};

const DEFAULT_GLM_API_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_GLM_DAILY_REPORT_MODEL = "glm-5.2";
const DEFAULT_GLM_TIMEOUT_MS = 20_000;
const MAX_PROJECTS = 30;
const MAX_SEGMENTS_PER_PROJECT = 80;
const MAX_EVENTS_PER_SEGMENT = 8;
const MAX_DETAIL_LENGTH = 240;

const DISABLED_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

const envValue = (name: string): string => process.env[name]?.trim() ?? "";

const truncateText = (value: unknown, maxLength = MAX_DETAIL_LENGTH): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trim()}...`;
};

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

const readPositiveIntEnv = (name: string, fallback: number): number => {
  const value = Number(envValue(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const makeRulesMetadata = (
  status: DailyReportSummarizerMetadata["status"],
  generatedAt: string,
  error?: string,
): DailyReportSummarizerMetadata => ({
  provider: "rules",
  model: null,
  status,
  generatedAt,
  generated_at: generatedAt,
  error: error ? truncateText(error, 500) : null,
});

const compactPayloadForPrompt = (payload: DailyReportPayload) => ({
  reportDate: payload.reportDate,
  timezone: payload.timezone,
  generatedAt: payload.generatedAt,
  rangeStart: payload.rangeStart,
  rangeEnd: payload.rangeEnd,
  totals: payload.totals,
  projects: payload.projects.slice(0, MAX_PROJECTS).map((project) => ({
    projectName: project.projectName,
    daemonHost: project.daemonHost,
    summary: project.summary,
    stats: project.stats,
    truncatedTasks: Math.max(0, project.timeline.length - MAX_SEGMENTS_PER_PROJECT),
    timeline: project.timeline.slice(0, MAX_SEGMENTS_PER_PROJECT).map((segment) => ({
      timeRange: segment.timeRange,
      taskTitle: segment.taskTitle,
      issueTitle: segment.issueTitle,
      status: segment.status,
      summary: segment.summary,
      events: segment.events.slice(0, MAX_EVENTS_PER_SEGMENT).map((event) => ({
        time: event.time,
        title: event.title,
        detail: truncateText(event.detail),
        role: event.role ?? null,
        status: event.status ?? null,
      })),
      truncatedEvents: Math.max(0, segment.events.length - MAX_EVENTS_PER_SEGMENT),
    })),
  })),
  truncatedProjects: Math.max(0, payload.projects.length - MAX_PROJECTS),
});

const buildMessages = (payload: DailyReportPayload, fallbackSummaryMarkdown: string) => [
  {
    role: "system",
    content: [
      "你是 Conductor 的每日工作日报 summarizer。",
      "只根据用户提供的 JSON 和规则摘要生成中文 Markdown，不要编造不存在的任务、时间、项目、结论。",
      "输出需要按 Project 组织，并保留当天时间轴。",
      "如果没有活动，用一句话说明当天没有记录到任务活动。",
      "推荐结构：# 每日总结 - 日期、## 总览、每个项目的 ## 项目名、### 时间轴。",
      "语言要简洁、可直接发送给用户。",
    ].join("\n"),
  },
  {
    role: "user",
    content: JSON.stringify(
      {
        instruction: "请将下面的日报数据整理成一份中文 Markdown 日报。",
        existingRuleSummary: fallbackSummaryMarkdown,
        reportData: compactPayloadForPrompt(payload),
      },
      null,
      2,
    ),
  },
];

const extractMessageContent = (payload: unknown): string => {
  const response = payload as ChatCompletionResponse;
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
};

const readResponseJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("GLM summarizer returned invalid JSON");
  }
};

export async function summarizeDailyReportWithGlm(input: {
  payload: DailyReportPayload;
  fallbackSummaryMarkdown: string;
  fetchImpl?: FetchLike;
}): Promise<GlmDailyReportSummaryResult> {
  const generatedAt = new Date().toISOString();
  const enabledFlag = envValue("DAILY_REPORT_AI_SUMMARY_ENABLED").toLowerCase();
  if (enabledFlag && DISABLED_VALUES.has(enabledFlag)) {
    return {
      summaryMarkdown: input.fallbackSummaryMarkdown,
      summarizer: makeRulesMetadata("disabled", generatedAt),
    };
  }

  const apiKey = envValue("GLM_API_KEY");
  if (!apiKey) {
    return {
      summaryMarkdown: input.fallbackSummaryMarkdown,
      summarizer: makeRulesMetadata("missing_api_key", generatedAt),
    };
  }

  const model = envValue("GLM_DAILY_REPORT_MODEL") || DEFAULT_GLM_DAILY_REPORT_MODEL;
  const baseUrl = normalizeBaseUrl(envValue("GLM_API_BASE_URL") || DEFAULT_GLM_API_BASE_URL);
  const timeoutMs = readPositiveIntEnv("GLM_DAILY_REPORT_TIMEOUT_MS", DEFAULT_GLM_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = input.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: buildMessages(input.payload, input.fallbackSummaryMarkdown),
        stream: false,
        thinking: { type: "disabled" },
        do_sample: false,
        temperature: 0.2,
        max_tokens: 4096,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = truncateText(await response.text(), 500);
      throw new Error(`GLM summarizer failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    const content = extractMessageContent(await readResponseJson(response));
    if (!content) {
      throw new Error("GLM summarizer returned an empty response");
    }

    return {
      summaryMarkdown: content,
      summarizer: {
        provider: "glm",
        model,
        status: "success",
        generatedAt,
        generated_at: generatedAt,
        error: null,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      summaryMarkdown: input.fallbackSummaryMarkdown,
      summarizer: makeRulesMetadata("fallback", generatedAt, message),
    };
  } finally {
    clearTimeout(timeout);
  }
}
