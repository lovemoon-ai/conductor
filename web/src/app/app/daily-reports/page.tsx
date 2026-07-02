'use client';

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { useDailyReportsStore, type DailyReportProject } from "@/features/daily-reports";
import { MarkdownRenderer } from "@/features/chat/components/MarkdownRenderer";

const pad2 = (value: number): string => String(value).padStart(2, "0");

const browserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
};

const formatLocalDate = (date: Date, timezone: string): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const addDays = (dateValue: string, days: number): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  if (!match) return dateValue;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
};

const formatTimestamp = (value: string | null, timezone: string): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const StatusDot = ({ status }: { status: string }) => {
  const normalized = status.toLowerCase();
  const className =
    normalized === "completed"
      ? "bg-success"
      : normalized === "running" || normalized === "init" || normalized === "killing"
        ? "bg-[var(--accent)]"
        : normalized === "killed" || normalized === "failed"
          ? "bg-error"
          : "bg-muted";
  return <span className={`mt-1 size-2 rounded-full ${className}`} aria-hidden />;
};

function ProjectSection({ project }: { project: DailyReportProject }) {
  return (
    <section className="webapp-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{project.projectName}</h3>
          {project.daemonHost ? (
            <p className="mt-0.5 truncate text-xs text-muted">{project.daemonHost}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <span>{project.stats.tasksTouched} tasks</span>
          <span>{project.stats.messages} messages</span>
          <span>{project.stats.completed} done</span>
        </div>
      </div>

      <div className="space-y-3">
        {project.timeline.map((segment) => (
          <div
            key={`${project.projectId}:${segment.taskId}:${segment.startAt}`}
            className="grid gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0 sm:grid-cols-[6.5rem_1fr]"
          >
            <div className="text-sm font-medium text-muted">{segment.timeRange}</div>
            <div className="min-w-0">
              <div className="flex items-start gap-2">
                <StatusDot status={segment.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h4 className="truncate text-sm font-semibold">{segment.taskTitle}</h4>
                    {segment.issueTitle ? (
                      <span className="rounded-full bg-[var(--surface-subtle)] px-2 py-0.5 text-[11px] text-muted">
                        {segment.issueTitle}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-muted">{segment.summary}</p>
                </div>
              </div>

              <div className="mt-2 space-y-1.5 pl-4">
                {segment.events.slice(0, 5).map((event) => (
                  <div key={`${event.timestamp}:${event.title}`} className="flex gap-2 text-xs text-muted">
                    <span className="w-11 shrink-0 font-medium text-ink">{event.time}</span>
                    <span className="min-w-0">
                      <span className="font-medium text-ink">{event.title}</span>
                      {event.detail ? <span>: {event.detail}</span> : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function DailyReportsPageContent() {
  const { replace } = useRouter();
  const searchParams = useSearchParams();
  const setting = useDailyReportsStore((state) => state.setting);
  const report = useDailyReportsStore((state) => state.currentReport);
  const history = useDailyReportsStore((state) => state.history);
  const isLoadingReport = useDailyReportsStore((state) => state.isLoadingReport);
  const isGenerating = useDailyReportsStore((state) => state.isGenerating);
  const error = useDailyReportsStore((state) => state.error);
  const hydrateSetting = useDailyReportsStore((state) => state.hydrateSetting);
  const fetchReport = useDailyReportsStore((state) => state.fetchReport);
  const generateReport = useDailyReportsStore((state) => state.generateReport);
  const fetchHistory = useDailyReportsStore((state) => state.fetchHistory);
  const timezone = setting?.timezone ?? browserTimezone();
  const initialDate = searchParams.get("date") || formatLocalDate(new Date(), timezone);
  const [selectedDate, setSelectedDate] = useState(initialDate);

  useEffect(() => {
    void hydrateSetting();
    void fetchHistory();
  }, [fetchHistory, hydrateSetting]);

  useEffect(() => {
    const queryDate = searchParams.get("date");
    if (queryDate && queryDate !== selectedDate) {
      setSelectedDate(queryDate);
    }
  }, [searchParams, selectedDate]);

  useEffect(() => {
    void fetchReport(selectedDate, timezone);
  }, [fetchReport, selectedDate, timezone]);

  const setDate = (nextDate: string) => {
    setSelectedDate(nextDate);
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set("date", nextDate);
    replace(`/app/daily-reports?${nextParams.toString()}`, { scroll: false });
  };

  const totals = report?.payload.totals;
  const summarizer = report?.payload.summarizer;
  const summaryMarkdown = report?.summaryMarkdown.trim() ?? "";
  const summaryBadge =
    summarizer?.provider === "glm" && summarizer.status === "success"
      ? `AI summary${summarizer.model ? `: ${summarizer.model}` : ""}`
      : summarizer?.status === "fallback"
        ? "Rule summary: AI fallback"
        : "Rule summary";
  const generatedLabel = report?.updatedAt || report?.createdAt
    ? formatTimestamp(report.updatedAt ?? report.createdAt, report.timezone)
    : null;

  const historyDates = useMemo(
    () => history.map((item) => item.reportDate).filter(Boolean),
    [history],
  );

  return (
    <>
      <Header
        title="Daily Reports"
        compact
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void fetchReport(selectedDate, timezone)}
              disabled={isLoadingReport}
              aria-label="Refresh daily report"
              title="Refresh daily report"
              className="flex items-center justify-center rounded-lg bg-paper/80 p-2 text-sm text-muted transition-colors hover:text-ink disabled:opacity-50"
            >
              <svg className={`size-4 ${isLoadingReport ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v6h6M20 20v-6h-6M5 19A8 8 0 0019 8.5M19 5a8 8 0 00-14 10.5" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => void generateReport(selectedDate, timezone)}
              disabled={isGenerating}
              className="webapp-btn-primary flex min-h-9 items-center gap-2 px-3 text-sm disabled:opacity-50"
            >
              <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {isGenerating ? "Generating" : "Generate"}
            </button>
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto p-4 webapp-scrollbar">
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
          <section className="webapp-card p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDate(addDays(selectedDate, -1))}
                  aria-label="Previous day"
                  title="Previous day"
                  className="flex size-9 items-center justify-center rounded-lg border border-border text-muted hover:text-ink"
                >
                  <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(event) => setDate(event.target.value)}
                  className="min-h-9 rounded-lg border border-border bg-paper px-3 text-sm text-ink outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
                />
                <button
                  type="button"
                  onClick={() => setDate(addDays(selectedDate, 1))}
                  aria-label="Next day"
                  title="Next day"
                  className="flex size-9 items-center justify-center rounded-lg border border-border text-muted hover:text-ink"
                >
                  <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="rounded-full bg-[var(--surface-subtle)] px-2.5 py-1">{timezone}</span>
                {report?.persisted ? (
                  <span className="rounded-full bg-success/10 px-2.5 py-1 text-success">Saved</span>
                ) : (
                  <span className="rounded-full bg-[var(--surface-subtle)] px-2.5 py-1">Preview</span>
                )}
                {generatedLabel ? (
                  <span className="rounded-full bg-[var(--surface-subtle)] px-2.5 py-1">{generatedLabel}</span>
                ) : null}
              </div>
            </div>

            {historyDates.length > 0 ? (
              <div className="mt-3 flex gap-2 overflow-x-auto webapp-scrollbar">
                {historyDates.map((date) => (
                  <button
                    key={date}
                    type="button"
                    onClick={() => setDate(date)}
                    className={`shrink-0 rounded-full border px-3 py-1 text-xs ${
                      selectedDate === date
                        ? "border-[var(--accent)] bg-[var(--accent)] text-white"
                        : "border-border text-muted hover:text-ink"
                    }`}
                  >
                    {date}
                  </button>
                ))}
              </div>
            ) : null}
          </section>

          {error ? (
            <div className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
              {error}
            </div>
          ) : null}

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              ["Projects", totals?.projects ?? 0],
              ["Tasks", totals?.tasks ?? 0],
              ["Messages", totals?.messages ?? 0],
              ["Completed", totals?.completed ?? 0],
              ["Running", totals?.running ?? 0],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border bg-panel px-4 py-3">
                <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
                <div className="mt-1 text-2xl font-semibold">{value}</div>
              </div>
            ))}
          </section>

          {report && summaryMarkdown ? (
            <section className="webapp-card p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">Summary</h2>
                <span
                  className={`rounded-full px-2.5 py-1 text-xs ${
                    summarizer?.provider === "glm" && summarizer.status === "success"
                      ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                      : "bg-[var(--surface-subtle)] text-muted"
                  }`}
                >
                  {summaryBadge}
                </span>
              </div>
              <MarkdownRenderer content={summaryMarkdown} />
            </section>
          ) : null}

          {isLoadingReport && !report ? (
            <div className="flex min-h-[16rem] items-center justify-center">
              <LoadingSpinner size="lg" />
            </div>
          ) : report && report.payload.projects.length > 0 ? (
            <div className="space-y-4">
              {report.payload.projects.map((project) => (
                <ProjectSection key={project.projectId} project={project} />
              ))}
            </div>
          ) : (
            <section className="webapp-card flex min-h-[14rem] items-center justify-center p-6 text-center text-muted">
              <div>
                <svg className="mx-auto mb-3 size-10 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 7h8M8 11h8M8 15h5M5 3h14a2 2 0 012 2v14l-4-2-4 2-4-2-4 2V5a2 2 0 012-2z" />
                </svg>
                <p className="text-sm">No task activity recorded for {selectedDate}</p>
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

export default function DailyReportsPage() {
  return (
    <Suspense fallback={null}>
      <DailyReportsPageContent />
    </Suspense>
  );
}
