import { db as defaultDb } from "@/lib/db";

/**
 * LLM-summarized cross-task handoff digest (borrowed from AgentsServer's
 * `POST /sessions/{id}/digest`). Instead of pasting a raw transcript into
 * another task, we build a bounded source packet from the task's recent
 * messages and ask an LLM to summarize it into a clean Markdown handoff.
 *
 * Unlike the daily report (which silently falls back to a rules summary), a
 * digest whose whole value IS the summary fails visibly: if the summarizer is
 * unavailable or errors, `summarizeHandoffDigest` throws `HandoffDigestError`
 * so the endpoint returns an explicit failure rather than a raw dump.
 */

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type DbLike = Pick<typeof defaultDb, "task" | "message">;

const DEFAULT_GLM_API_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_GLM_HANDOFF_MODEL = "glm-5.2";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MESSAGES = 60;
const DEFAULT_MAX_CHARS = 24_000;
const MAX_MESSAGE_CHARS = 2_000;

export type DigestReason =
  | "missing_api_key"
  | "empty_response"
  | "http_error"
  | "network_error"
  | "invalid_json";

export class HandoffDigestError extends Error {
  reason: DigestReason;
  constructor(reason: DigestReason, message: string) {
    super(message);
    this.name = "HandoffDigestError";
    this.reason = reason;
  }
}

export type DigestSourcePacket = {
  taskId: string;
  taskTitle: string;
  backend: string | null;
  projectName: string | null;
  messageCount: number;
  truncatedMessages: number;
  messages: Array<{ role: string; text: string }>;
};

export type HandoffDigestResult = {
  digestMarkdown: string;
  summarizer: { provider: "glm"; model: string; generatedAt: string };
};

const envValue = (name: string): string => process.env[name]?.trim() ?? "";

const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, "");

const readPositiveIntEnv = (name: string, fallback: number): number => {
  const value = Number(envValue(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1).trim()}…`;

/**
 * Gather a bounded, chronological source packet from a task's messages, scoped
 * to the owning user. Returns null when the task does not exist or is not owned
 * by the user.
 */
export async function buildDigestSourcePacket(input: {
  userId: string;
  taskId: string;
  maxMessages?: number;
  maxChars?: number;
  client?: DbLike;
}): Promise<DigestSourcePacket | null> {
  const db = input.client ?? defaultDb;
  const maxMessages = input.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxChars = input.maxChars ?? readPositiveIntEnv("GLM_HANDOFF_DIGEST_MAX_CHARS", DEFAULT_MAX_CHARS);

  const task = await db.task.findFirst({
    where: { id: input.taskId, project: { userId: input.userId } },
    select: {
      id: true,
      title: true,
      backendType: true,
      project: { select: { name: true } },
    },
  });
  if (!task) {
    return null;
  }

  // Most recent messages first, then reverse to chronological order so the
  // digest reads top-to-bottom.
  const recent = await db.message.findMany({
    where: { taskId: input.taskId },
    orderBy: { createdAt: "desc" },
    take: maxMessages,
    select: { role: true, content: true },
  });
  const chronological = recent.reverse();

  const messages: Array<{ role: string; text: string }> = [];
  let usedChars = 0;
  let truncatedMessages = 0;
  for (const message of chronological) {
    const text = truncate(message.content.replace(/\s+/g, " ").trim(), MAX_MESSAGE_CHARS);
    if (!text) continue;
    if (usedChars + text.length > maxChars) {
      truncatedMessages = chronological.length - messages.length;
      break;
    }
    usedChars += text.length;
    messages.push({ role: message.role, text });
  }

  return {
    taskId: task.id,
    taskTitle: task.title,
    backend: task.backendType,
    projectName: task.project?.name ?? null,
    messageCount: messages.length,
    truncatedMessages,
    messages,
  };
}

const buildChatMessages = (packet: DigestSourcePacket) => [
  {
    role: "system",
    content: [
      "你是 Conductor 的任务交接（handoff）摘要器。",
      "输入 JSON 是一个 AI 编码任务的对话记录（用户消息与 AI 消息按时间顺序排列）。",
      "只能根据输入 JSON 生成中文 Markdown 交接文档，不要使用外部知识或未提供的信息。",
      "目标：让另一个 agent 或开发者读完就能无缝接手，而不是复述对话。",
      "输出结构固定为：# 任务交接、## 目标与背景、## 已完成、## 当前状态 / 未决问题、## 下一步、## 关键文件与决策。",
      "如果某一节没有可用信息，写“暂无”，不要编造。",
      "简洁、有判断，突出接手所需的关键上下文。",
    ].join("\n"),
  },
  {
    role: "user",
    content: JSON.stringify(
      {
        instruction: "请把下面的任务对话整理成可直接交接的 Markdown 文档。",
        task: {
          title: packet.taskTitle,
          backend: packet.backend,
          project: packet.projectName,
          truncatedEarlierMessages: packet.truncatedMessages,
        },
        conversation: packet.messages,
      },
      null,
      2,
    ),
  },
];

const extractMessageContent = (payload: unknown): string => {
  const response = payload as ChatCompletionResponse;
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
};

/**
 * Summarize a source packet into a Markdown handoff via the GLM
 * chat-completions API. Throws `HandoffDigestError` on any failure so the
 * caller can surface an explicit error instead of a partial/raw digest.
 */
export async function summarizeHandoffDigest(input: {
  packet: DigestSourcePacket;
  fetchImpl?: FetchLike;
}): Promise<HandoffDigestResult> {
  const generatedAt = new Date().toISOString();
  const apiKey = envValue("GLM_API_KEY");
  if (!apiKey) {
    throw new HandoffDigestError("missing_api_key", "GLM_API_KEY is not configured");
  }

  const model = envValue("GLM_HANDOFF_DIGEST_MODEL") || envValue("GLM_DAILY_REPORT_MODEL") || DEFAULT_GLM_HANDOFF_MODEL;
  const baseUrl = normalizeBaseUrl(envValue("GLM_API_BASE_URL") || DEFAULT_GLM_API_BASE_URL);
  const timeoutMs = readPositiveIntEnv("GLM_HANDOFF_DIGEST_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = input.fetchImpl ?? fetch;

  try {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: buildChatMessages(input.packet),
          stream: false,
          thinking: { type: "disabled" },
          do_sample: false,
          temperature: 0.2,
          max_tokens: 4096,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new HandoffDigestError(
        "network_error",
        error instanceof Error ? error.message : String(error),
      );
    }

    if (!response.ok) {
      const detail = truncate((await response.text().catch(() => "")).trim(), 500);
      throw new HandoffDigestError("http_error", `GLM digest failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      throw new HandoffDigestError("invalid_json", "GLM digest returned invalid JSON");
    }

    const content = extractMessageContent(parsed);
    if (!content) {
      throw new HandoffDigestError("empty_response", "GLM digest returned an empty response");
    }

    return { digestMarkdown: content, summarizer: { provider: "glm", model, generatedAt } };
  } finally {
    clearTimeout(timeout);
  }
}
