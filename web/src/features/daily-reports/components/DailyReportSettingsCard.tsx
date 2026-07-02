'use client';

import { useEffect, useMemo, useState } from "react";
import { useDailyReportsStore } from "../store";

const formatDateTime = (value: string | null, timezone: string): string => {
  if (!value) return "Not scheduled";
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

export function DailyReportSettingsCard() {
  const setting = useDailyReportsStore((state) => state.setting);
  const isLoading = useDailyReportsStore((state) => state.isLoadingSetting);
  const isSaving = useDailyReportsStore((state) => state.isSavingSetting);
  const error = useDailyReportsStore((state) => state.error);
  const hydrateSetting = useDailyReportsStore((state) => state.hydrateSetting);
  const updateSetting = useDailyReportsStore((state) => state.updateSetting);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    void hydrateSetting();
  }, [hydrateSetting]);

  useEffect(() => {
    if (!setting) return;
    setEnabled(setting.enabled);
  }, [setting]);

  const hasChanges = useMemo(() => {
    if (!setting) return true;
    return enabled !== setting.enabled;
  }, [enabled, setting]);

  const handleSave = () => {
    void updateSetting({
      enabled,
      deliveryChannels: ["in_app"],
    });
  };

  return (
    <section className="webapp-card p-5" data-testid="daily-report-settings-card">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-[var(--accent)]/10 text-[var(--accent)]">
          <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h8M8 11h8M8 15h5M5 3h14a2 2 0 012 2v14l-4-2-4 2-4-2-4 2V5a2 2 0 012-2z" />
          </svg>
        </div>
        <div className="min-w-0">
          <h3 className="text-lg font-semibold">Daily Summary</h3>
          <p className="text-sm text-muted">Entry and schedule</p>
        </div>
      </div>

      <div className="space-y-3">
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-paper px-3 py-3">
          <span className="text-sm font-medium">Show Daily and auto-send</span>
          <input
            type="checkbox"
            aria-label="Show Daily and auto-send"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="size-4 accent-[var(--accent)]"
            disabled={isLoading || isSaving}
          />
        </label>

        <div className="grid gap-2 text-sm text-muted sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-paper px-3 py-3">
            <span className="block text-xs uppercase tracking-wide text-muted">Next run</span>
            <span className="mt-1 block font-medium text-ink">
              {formatDateTime(setting?.nextRunAt ?? null, setting?.timezone ?? "Asia/Shanghai")}
            </span>
          </div>
          <div className="rounded-lg border border-border bg-paper px-3 py-3">
            <span className="block text-xs uppercase tracking-wide text-muted">Last sent</span>
            <span className="mt-1 block font-medium text-ink">
              {setting?.lastSentForDate ?? "None"}
            </span>
          </div>
        </div>

        {error ? (
          <p className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={isLoading || isSaving || !hasChanges}
            className="webapp-btn-primary inline-flex min-h-10 items-center gap-2 px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {isSaving ? "Saving" : "Save"}
          </button>
        </div>
      </div>
    </section>
  );
}
