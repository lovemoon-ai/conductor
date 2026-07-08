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

type DailyReportPromptEvent =
  DailyReportPayload["projects"][number]["timeline"][number]["events"][number];

const DEFAULT_GLM_API_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_GLM_DAILY_REPORT_MODEL = "glm-5.2";
const DEFAULT_GLM_TIMEOUT_MS = 20_000;
const MAX_PROJECTS = 30;
const MAX_SEGMENTS_PER_PROJECT = 80;
const MAX_EVENTS_PER_SEGMENT = 12;
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

const compactEventKind = (event: DailyReportPromptEvent): string => {
  if (event.type === "message") {
    const role = event.role?.trim().toLowerCase();
    if (role === "user") return "user_message";
    if (role === "assistant" || role === "ai") return "assistant_message";
    return role ? `${role}_message` : "message";
  }
  if (event.type === "status") return "status_change";
  return event.type;
};

const compactPayloadForPrompt = (payload: DailyReportPayload) => ({
  reportDate: payload.reportDate,
  timezone: payload.timezone,
  generatedAt: payload.generatedAt,
  rangeStart: payload.rangeStart,
  rangeEnd: payload.rangeEnd,
  totals: payload.totals,
  source: {
    description:
      "Conductor 后台按当前用户和报告日期筛选的活动 evidence。只使用这些 evidence。",
    includes: ["projects", "tasks", "user messages", "AI messages", "task status events"],
  },
  projects: payload.projects.slice(0, MAX_PROJECTS).map((project) => ({
    projectName: project.projectName,
    daemonHost: project.daemonHost,
    stats: project.stats,
    truncatedTasks: Math.max(0, project.timeline.length - MAX_SEGMENTS_PER_PROJECT),
    taskEvidence: project.timeline.slice(0, MAX_SEGMENTS_PER_PROJECT).map((segment) => ({
      taskTitle: segment.taskTitle,
      issueTitle: segment.issueTitle,
      status: segment.status,
      activitySummary: segment.summary,
      activityMessages: segment.events.slice(0, MAX_EVENTS_PER_SEGMENT).map((event) => ({
        time: event.time,
        kind: compactEventKind(event),
        text: truncateText(event.detail),
        role: event.role ?? null,
        status: event.status ?? null,
      })),
      truncatedMessages: Math.max(0, segment.events.length - MAX_EVENTS_PER_SEGMENT),
    })),
  })),
  truncatedProjects: Math.max(0, payload.projects.length - MAX_PROJECTS),
});

const buildMessages = (payload: DailyReportPayload, fallbackSummaryMarkdown: string) => [
  {
    role: "system",
    content: [
      "你是 Conductor 后台服务里的开发者每日复盘 summarizer。",
      "输入 JSON 是 Conductor 后台按当前用户、报告日期和 timezone 查询到的当天活动 evidence，包括项目、任务、用户消息、AI 消息和任务状态事件。",
      "只能根据输入 JSON 生成中文 Markdown，不要使用本地仓库上下文、外部知识、commit 记录或未提供的信息。",
      "目标不是罗列活动，而是帮助开发者复盘为什么做这些事、是否值得继续投入、注意力是否发散，以及明天如何收敛。",
      "不要写产物、commit、命令、链接、任务时间线或逐条消息流水账。",
      "按 Project 聚合，但最多重点复盘 3 个主要项目；其余项目合并到注意力评估。",
      "每个项目必须评估：做了什么、为什么做、是否值得、评估理由、今天获得的判断、下一步。",
      "如果输入无法支持某个原因或价值判断，直接写无法判断，不要编造。",
      "必须明确判断今日主线是否聚焦；如果多个项目并行，要分析是否发散以及发散代价。",
      "如果没有活动，用一句话说明当天没有记录到任务活动。",
      "输出结构固定为：# 每日复盘 - 日期、## 1. 今日主线判断、## 2. 项目复盘、## 3. 注意力评估、## 4. 明日聚焦。",
      "语言要简洁、有判断，适合开发者自己复盘。",
    ].join("\n"),
  },
  {
    role: "user",
    content: JSON.stringify(
      {
        instruction:
          "请根据 Conductor 后台活动 evidence 生成开发者自用每日复盘。不要复述时间线，重点分析为什么做、是否值得、是否发散、明天如何聚焦。",
        outputTemplate: [
          "# 每日复盘 - YYYY-MM-DD",
          "## 1. 今日主线判断",
          "## 2. 项目复盘",
          "### 项目名",
          "- 做了什么：",
          "- 为什么做：",
          "- 是否值得：值得 / 一般 / 不值得 / 无法判断",
          "- 评估理由：",
          "- 今天获得的判断：",
          "- 下一步：继续 / 收敛 / 暂停 / 放弃 / 无法判断",
          "## 3. 注意力评估",
          "## 4. 明日聚焦",
        ],
        fallbackSummaryAvailable: Boolean(fallbackSummaryMarkdown),
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
