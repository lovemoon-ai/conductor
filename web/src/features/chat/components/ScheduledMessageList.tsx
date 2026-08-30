'use client';

import type { ScheduledMessageSummary } from '@/shared/types';
import type { ScheduledMessageStatusFilter } from '@/lib/tasks/scheduled-message-schema';

interface ScheduledMessageListProps {
  schedules: ScheduledMessageSummary[];
  loading: boolean;
  error: string | null;
  keyword: string;
  statusFilter: ScheduleStatusFilter;
  pendingId: string | null;
  onKeywordChange: (value: string) => void;
  onStatusFilterChange: (value: ScheduleStatusFilter) => void;
  onRefresh: () => void;
  onEdit: (schedule: ScheduledMessageSummary) => void;
  onRemove: (schedule: ScheduledMessageSummary) => void;
  onCreate: () => void;
}

// `sending` is deliberately absent: it lasts a single dispatcher tick, so a chip
// for it would almost always come back empty. Every other status gets one --
// notably `sent`, the terminal state of a one-off send.
const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'sent', label: 'Sent' },
  { value: 'completed', label: 'Completed' },
  { value: 'canceled', label: 'Canceled' },
  { value: 'failed', label: 'Failed' },
] as const satisfies readonly { value: ScheduledMessageStatusFilter; label: string }[];

// Derived from the chips, so the filter union can never carry a value the UI
// has no way to select.
export type ScheduleStatusFilter = (typeof STATUS_FILTERS)[number]['value'];

const STATUS_BADGE_CLASSNAME: Record<string, string> = {
  active: 'bg-[var(--success)]/15 text-[var(--success)]',
  sending: 'bg-[var(--warning)]/15 text-[var(--warning)]',
  failed: 'bg-[var(--error)]/15 text-[var(--error)]',
};

const inputClassName = 'h-10 w-full rounded-lg border border-border bg-paper px-3 text-sm text-ink outline-none transition-colors focus:border-ink';

const formatDateTime = (iso?: string | null): string => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const formatDuration = (ms?: number | null): string => {
  if (!ms || ms <= 0) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours}h`;
  }
  return `${minutes}m`;
};

/** One-line human summary of when a schedule fires. */
export const describeSchedule = (schedule: ScheduledMessageSummary): string => {
  if (schedule.kind === 'interval') {
    const base = `Every ${formatDuration(schedule.intervalMs)}`;
    return schedule.condition === 'ai_idle' ? `${base}, only when AI is idle` : base;
  }
  if (schedule.kind === 'once_at') {
    return `Once at ${formatDateTime(schedule.nextRunAt)}`;
  }
  return 'Once, after a delay';
};

export function ScheduledMessageList({
  schedules,
  loading,
  error,
  keyword,
  statusFilter,
  pendingId,
  onKeywordChange,
  onStatusFilterChange,
  onRefresh,
  onEdit,
  onRemove,
  onCreate,
}: ScheduledMessageListProps) {
  return (
    <div className="flex max-h-[calc(100dvh-14rem)] min-h-0 flex-col sm:max-h-[calc(100dvh-13rem)]">
      <div className="flex shrink-0 flex-col gap-3 pb-3">
        <div className="flex gap-2">
          <input
            aria-label="Search scheduled messages"
            placeholder="Search message content"
            className={inputClassName}
            value={keyword}
            onChange={(event) => onKeywordChange(event.target.value)}
          />
          <button
            type="button"
            onClick={onRefresh}
            className="shrink-0 rounded-lg border border-border px-3 text-sm font-medium text-ink transition-colors hover:bg-border/35"
          >
            Refresh
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => onStatusFilterChange(filter.value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                statusFilter === filter.value
                  ? 'webapp-gradient-bg border-transparent text-white'
                  : 'border-border bg-paper text-muted hover:bg-border/35'
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <div className="webapp-scrollbar -mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1 pb-4">
        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {loading ? (
          <p className="py-6 text-center text-sm text-muted">Loading scheduled messages...</p>
        ) : null}

        {!loading && !error && schedules.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">
            No scheduled messages match this filter.
          </p>
        ) : null}

        {schedules.map((schedule) => {
          const isActive = schedule.status === 'active';
          const busy = pendingId === schedule.id;
          return (
            <div
              key={schedule.id}
              data-testid="scheduled-message-row"
              className="space-y-2 rounded-xl border border-border bg-paper p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${
                    STATUS_BADGE_CLASSNAME[schedule.status] ?? 'bg-border/50 text-muted'
                  }`}
                >
                  {schedule.status}
                </span>
                <span className="text-xs text-muted">{describeSchedule(schedule)}</span>
              </div>

              <p className="line-clamp-3 whitespace-pre-wrap text-sm text-ink">{schedule.content}</p>

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <span>{isActive ? `Next: ${formatDateTime(schedule.nextRunAt)}` : `Last: ${formatDateTime(schedule.lastRunAt)}`}</span>
                <span>
                  Sent {schedule.runCount}
                  {schedule.maxRuns ? `/${schedule.maxRuns}` : ''}
                </span>
                {schedule.skipCount > 0 ? <span>Skipped {schedule.skipCount}</span> : null}
                {schedule.stopAt ? <span>Stops {formatDateTime(schedule.stopAt)}</span> : null}
              </div>

              {schedule.lastError ? (
                <p className="text-xs text-[var(--error)]">Last result: {schedule.lastError}</p>
              ) : null}

              <div className="flex justify-end gap-2">
                {isActive ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onEdit(schedule)}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-border/35 disabled:opacity-60"
                  >
                    Edit
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRemove(schedule)}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-[var(--error)] transition-colors hover:bg-border/35 disabled:opacity-60"
                >
                  {isActive ? 'Cancel' : 'Delete'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="-mx-5 -mb-5 flex shrink-0 justify-end gap-3 border-t border-border bg-panel px-5 py-4">
        <button
          type="button"
          onClick={onCreate}
          className="webapp-gradient-bg rounded-lg px-4 py-2 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-95"
        >
          New Schedule
        </button>
      </div>
    </div>
  );
}
