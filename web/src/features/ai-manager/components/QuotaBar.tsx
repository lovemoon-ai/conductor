'use client';

import type { QuotaWindow } from '../types';

interface QuotaBarProps {
  label: string;
  window?: QuotaWindow;
}

const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatReset(window: QuotaWindow): string {
  const epochSeconds =
    window.resetAt ??
    (window.resetAfterSeconds !== undefined
      ? Math.floor(Date.now() / 1000) + window.resetAfterSeconds
      : undefined);
  if (epochSeconds === undefined) return '';
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === new Date().toDateString();
  return `reset ${sameDay ? TIME_FORMATTER.format(date) : DATE_TIME_FORMATTER.format(date)}`;
}

function barColor(usedPercent: number, status?: string): string {
  if (status === 'blocked') return 'bg-[var(--error)]';
  if (status === 'warning' || usedPercent >= 80) return 'bg-amber-500';
  return 'webapp-gradient-bg';
}

export function QuotaBar({ label, window }: QuotaBarProps) {
  if (!window) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium text-ink">{label}</span>
          <span className="text-xs text-muted">—</span>
        </div>
        <div className="h-2 rounded-full bg-paper" />
      </div>
    );
  }

  const used = Math.max(0, Math.min(100, window.usedPercent ?? 0));
  const remaining = Math.max(0, Math.min(100, window.remainingPercent ?? 100 - used));
  const reset = formatReset(window);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-ink">{label}</span>
        <span className="text-xs text-muted">
          剩 {remaining.toFixed(0)}%{reset ? ` · ${reset}` : ''}
        </span>
      </div>
      <div
        className="h-2 rounded-full bg-paper"
        role="progressbar"
        aria-valuenow={Math.round(used)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} usage`}
      >
        <div
          className={`h-2 rounded-full transition-all ${barColor(used, window.status)}`}
          style={{ width: `${used}%` }}
        />
      </div>
    </div>
  );
}
