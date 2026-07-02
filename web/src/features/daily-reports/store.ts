import { create } from "zustand";
import { getApiClient } from "@/shared/api/client";

export type DailyReportDeliveryChannel = "in_app" | "feishu";

export type DailyReportSetting = {
  enabled: boolean;
  timezone: string;
  sendTimeLocal: string;
  deliveryChannels: DailyReportDeliveryChannel[];
  nextRunAt: string | null;
  lastSentForDate: string | null;
  lastRunAt: string | null;
  lastError: string | null;
};

export type DailyReportEvent = {
  type: string;
  timestamp: string;
  time: string;
  title: string;
  detail: string | null;
  role?: string | null;
  status?: string | null;
};

export type DailyReportTaskSegment = {
  taskId: string;
  taskTitle: string;
  issueTitle: string | null;
  status: string;
  startAt: string;
  endAt: string | null;
  timeRange: string;
  summary: string;
  events: DailyReportEvent[];
};

export type DailyReportProject = {
  projectId: string;
  projectName: string;
  daemonHost: string | null;
  summary: string;
  stats: {
    tasksTouched: number;
    messages: number;
    completed: number;
    running: number;
    killed: number;
  };
  timeline: DailyReportTaskSegment[];
};

export type DailyReportSummarizer = {
  provider: "rules" | "glm";
  model: string | null;
  status: string;
  generatedAt: string;
  error: string | null;
};

export type DailyReport = {
  id: string | null;
  reportDate: string;
  timezone: string;
  status: string;
  summaryMarkdown: string;
  payload: {
    totals: {
      projects: number;
      tasks: number;
      messages: number;
      completed: number;
      running: number;
      killed: number;
    };
    projects: DailyReportProject[];
    summarizer: DailyReportSummarizer | null;
  };
  deliveryChannels: DailyReportDeliveryChannel[];
  sentAt: string | null;
  lastError: string | null;
  persisted: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

type DailyReportsState = {
  setting: DailyReportSetting | null;
  currentReport: DailyReport | null;
  history: DailyReport[];
  isLoadingSetting: boolean;
  isLoadingReport: boolean;
  isSavingSetting: boolean;
  isGenerating: boolean;
  error: string | null;
  hydrateSetting: () => Promise<DailyReportSetting | null>;
  updateSetting: (input: Partial<DailyReportSetting>) => Promise<DailyReportSetting | null>;
  fetchReport: (date: string, timezone?: string | null) => Promise<DailyReport | null>;
  generateReport: (date: string, timezone?: string | null) => Promise<DailyReport | null>;
  fetchHistory: () => Promise<void>;
  applySettingUpdate: (value: unknown) => void;
  handleReportReady: (payload: Record<string, unknown>) => Promise<void>;
  clearError: () => void;
};

const normalizeSetting = (value: any): DailyReportSetting => {
  const channels = Array.isArray(value?.deliveryChannels)
    ? value.deliveryChannels
    : Array.isArray(value?.delivery_channels)
      ? value.delivery_channels
      : ["in_app"];
  return {
    enabled: Boolean(value?.enabled),
    timezone: typeof value?.timezone === "string" ? value.timezone : "Asia/Shanghai",
    sendTimeLocal:
      typeof value?.sendTimeLocal === "string"
        ? value.sendTimeLocal
        : typeof value?.send_time_local === "string"
          ? value.send_time_local
          : "20:00",
    deliveryChannels: channels.filter((item: unknown) => item === "in_app" || item === "feishu"),
    nextRunAt: value?.nextRunAt ?? value?.next_run_at ?? null,
    lastSentForDate: value?.lastSentForDate ?? value?.last_sent_for_date ?? null,
    lastRunAt: value?.lastRunAt ?? value?.last_run_at ?? null,
    lastError: value?.lastError ?? value?.last_error ?? null,
  };
};

const normalizeEvent = (value: any): DailyReportEvent => ({
  type: String(value?.type ?? ""),
  timestamp: String(value?.timestamp ?? ""),
  time: String(value?.time ?? ""),
  title: String(value?.title ?? ""),
  detail: typeof value?.detail === "string" ? value.detail : null,
  role: typeof value?.role === "string" ? value.role : null,
  status: typeof value?.status === "string" ? value.status : null,
});

const normalizeSegment = (value: any): DailyReportTaskSegment => ({
  taskId: String(value?.taskId ?? value?.task_id ?? ""),
  taskTitle: String(value?.taskTitle ?? value?.task_title ?? ""),
  issueTitle:
    typeof value?.issueTitle === "string"
      ? value.issueTitle
      : typeof value?.issue_title === "string"
        ? value.issue_title
        : null,
  status: String(value?.status ?? ""),
  startAt: String(value?.startAt ?? value?.start_at ?? ""),
  endAt: value?.endAt ?? value?.end_at ?? null,
  timeRange: String(value?.timeRange ?? value?.time_range ?? ""),
  summary: String(value?.summary ?? ""),
  events: Array.isArray(value?.events) ? value.events.map(normalizeEvent) : [],
});

const normalizeProject = (value: any): DailyReportProject => ({
  projectId: String(value?.projectId ?? value?.project_id ?? ""),
  projectName: String(value?.projectName ?? value?.project_name ?? ""),
  daemonHost: value?.daemonHost ?? value?.daemon_host ?? null,
  summary: String(value?.summary ?? ""),
  stats: {
    tasksTouched: Number(value?.stats?.tasksTouched ?? value?.stats?.tasks_touched ?? 0),
    messages: Number(value?.stats?.messages ?? 0),
    completed: Number(value?.stats?.completed ?? 0),
    running: Number(value?.stats?.running ?? 0),
    killed: Number(value?.stats?.killed ?? 0),
  },
  timeline: Array.isArray(value?.timeline) ? value.timeline.map(normalizeSegment) : [],
});

const normalizeSummarizer = (value: any): DailyReportSummarizer | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const provider = value.provider === "glm" ? "glm" : value.provider === "rules" ? "rules" : null;
  if (!provider) {
    return null;
  }
  return {
    provider,
    model: typeof value.model === "string" ? value.model : null,
    status: String(value.status ?? ""),
    generatedAt: String(value.generatedAt ?? value.generated_at ?? ""),
    error: typeof value.error === "string" ? value.error : null,
  };
};

const normalizeReport = (value: any): DailyReport => ({
  id: typeof value?.id === "string" ? value.id : null,
  reportDate: String(value?.reportDate ?? value?.report_date ?? ""),
  timezone: String(value?.timezone ?? "Asia/Shanghai"),
  status: String(value?.status ?? ""),
  summaryMarkdown: String(value?.summaryMarkdown ?? value?.summary_markdown ?? ""),
  payload: {
    totals: {
      projects: Number(value?.payload?.totals?.projects ?? 0),
      tasks: Number(value?.payload?.totals?.tasks ?? 0),
      messages: Number(value?.payload?.totals?.messages ?? 0),
      completed: Number(value?.payload?.totals?.completed ?? 0),
      running: Number(value?.payload?.totals?.running ?? 0),
      killed: Number(value?.payload?.totals?.killed ?? 0),
    },
    projects: Array.isArray(value?.payload?.projects) ? value.payload.projects.map(normalizeProject) : [],
    summarizer: normalizeSummarizer(value?.payload?.summarizer),
  },
  deliveryChannels: Array.isArray(value?.deliveryChannels)
    ? value.deliveryChannels
    : Array.isArray(value?.delivery_channels)
      ? value.delivery_channels
      : ["in_app"],
  sentAt: value?.sentAt ?? value?.sent_at ?? null,
  lastError: value?.lastError ?? value?.last_error ?? null,
  persisted: Boolean(value?.persisted),
  createdAt: value?.createdAt ?? value?.created_at ?? null,
  updatedAt: value?.updatedAt ?? value?.updated_at ?? null,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Failed to load daily reports";

export const useDailyReportsStore = create<DailyReportsState>()((set, get) => ({
  setting: null,
  currentReport: null,
  history: [],
  isLoadingSetting: false,
  isLoadingReport: false,
  isSavingSetting: false,
  isGenerating: false,
  error: null,

  hydrateSetting: async () => {
    const current = get();
    if (current.isLoadingSetting) {
      return current.setting;
    }
    set({ isLoadingSetting: true, error: null });
    try {
      const setting = normalizeSetting(await getApiClient().get("/user-preferences/daily-report"));
      set({ setting, isLoadingSetting: false, error: null });
      return setting;
    } catch (error) {
      set({ isLoadingSetting: false, error: errorMessage(error) });
      return null;
    }
  },

  updateSetting: async (input) => {
    set({ isSavingSetting: true, error: null });
    try {
      const setting = normalizeSetting(
        await getApiClient().patch("/user-preferences/daily-report", {
          enabled: input.enabled,
          deliveryChannels: input.deliveryChannels,
        }),
      );
      set({ setting, isSavingSetting: false, error: null });
      return setting;
    } catch (error) {
      set({ isSavingSetting: false, error: errorMessage(error) });
      return null;
    }
  },

  fetchReport: async (date, timezone) => {
    set({ isLoadingReport: true, error: null });
    try {
      const params = new URLSearchParams({ date });
      if (timezone) params.set("timezone", timezone);
      const report = normalizeReport(await getApiClient().get(`/daily-reports?${params.toString()}`));
      set({ currentReport: report, isLoadingReport: false, error: null });
      return report;
    } catch (error) {
      set({ isLoadingReport: false, error: errorMessage(error) });
      return null;
    }
  },

  generateReport: async (date, timezone) => {
    set({ isGenerating: true, error: null });
    try {
      const report = normalizeReport(
        await getApiClient().post("/daily-reports", {
          reportDate: date,
          timezone,
        }),
      );
      set({ currentReport: report, isGenerating: false, error: null });
      await get().fetchHistory();
      return report;
    } catch (error) {
      set({ isGenerating: false, error: errorMessage(error) });
      return null;
    }
  },

  fetchHistory: async () => {
    try {
      const response = (await getApiClient().get("/daily-reports?list=1&limit=14")) as { reports?: unknown[] };
      set({ history: Array.isArray(response?.reports) ? response.reports.map(normalizeReport) : [] });
    } catch {
      set({ history: [] });
    }
  },

  applySettingUpdate: (value) => {
    if (!value || typeof value !== "object") {
      return;
    }
    set({ setting: normalizeSetting(value), error: null });
  },

  handleReportReady: async (payload) => {
    await get().fetchHistory();

    const reportDate =
      typeof payload.reportDate === "string"
        ? payload.reportDate
        : typeof payload.report_date === "string"
          ? payload.report_date
          : null;
    const currentReport = get().currentReport;
    if (!reportDate || currentReport?.reportDate !== reportDate) {
      return;
    }

    const timezone =
      typeof payload.timezone === "string"
        ? payload.timezone
        : currentReport.timezone;
    await get().fetchReport(reportDate, timezone);
  },

  clearError: () => set({ error: null }),
}));
