'use client';

import { useMemo, useState } from 'react';
import { useToast } from '@/components/common/FeedbackProvider';
import { getApiClient } from '@/shared/api/client';
import type { ScheduledMessageSummary } from '@/shared/types';

type ScheduleMode = 'delay' | 'at' | 'interval' | 'idle_interval';
type TimeUnit = 'minute' | 'hour';

interface ScheduledMessageFormProps {
  taskId: string;
  /** Prefilled body: the picked message, the composer draft, or the edited row. */
  initialContent: string;
  /** Only set when scheduling an existing, persisted message. */
  sourceMessageId?: string | null;
  /** Present when editing an existing schedule; null creates a new one. */
  schedule?: ScheduledMessageSummary | null;
  onSaved: () => void;
  onCancel: () => void;
}

const HOUR_MS = 60 * 60_000;
const MINUTE_MS = 60_000;

const pad2 = (value: number) => String(value).padStart(2, '0');

const toLocalDateTimeInputValue = (date: Date) => {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  return `${year}-${month}-${day}T${hour}:${minute}`;
};

const parsePositiveInteger = (value: string): number | null => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const toIsoFromLocalDateTime = (value: string): string | null => {
  if (!value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

/** Splits a millisecond span into the largest whole unit the form can show. */
const splitDuration = (ms: number): { amount: number; unit: TimeUnit } => {
  const safeMs = Math.max(MINUTE_MS, ms);
  if (safeMs % HOUR_MS === 0) {
    return { amount: safeMs / HOUR_MS, unit: 'hour' };
  }
  return { amount: Math.max(1, Math.round(safeMs / MINUTE_MS)), unit: 'minute' };
};

const initialModeFor = (schedule?: ScheduledMessageSummary | null): ScheduleMode => {
  if (!schedule) return 'delay';
  if (schedule.kind === 'once_at') return 'at';
  if (schedule.kind === 'interval') {
    return schedule.condition === 'ai_idle' ? 'idle_interval' : 'interval';
  }
  return 'delay';
};

const modeButtonClassName = (active: boolean) =>
  `min-h-10 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
    active
      ? 'webapp-gradient-bg border-transparent text-white shadow-sm hover:opacity-95'
      : 'border-border bg-paper text-ink hover:bg-border/35'
  }`;

const inputClassName = 'h-10 w-full rounded-lg border border-border bg-paper px-3 text-sm text-ink outline-none transition-colors focus:border-ink';
const labelClassName = 'text-sm font-medium text-ink';

/**
 * Create/edit form for a scheduled message. The parent mounts it with a `key`
 * tied to the edited row, so every state seed below runs once per target and no
 * reset effect is needed.
 */
export function ScheduledMessageForm({
  taskId,
  initialContent,
  sourceMessageId,
  schedule = null,
  onSaved,
  onCancel,
}: ScheduledMessageFormProps) {
  const { pushToast } = useToast();
  const isEdit = Boolean(schedule);

  // A `once_delay` row stores no original amount, only the deadline, so the
  // form re-anchors it to the time still remaining.
  const initialDelay = useMemo(
    () =>
      schedule && schedule.kind === 'once_delay'
        ? splitDuration(new Date(schedule.nextRunAt).getTime() - Date.now())
        : { amount: 10, unit: 'minute' as TimeUnit },
    [schedule],
  );
  const initialInterval = useMemo(
    () =>
      schedule?.intervalMs
        ? splitDuration(schedule.intervalMs)
        : { amount: 1, unit: 'hour' as TimeUnit },
    [schedule],
  );

  const [mode, setMode] = useState<ScheduleMode>(() => initialModeFor(schedule));
  const [delayAmount, setDelayAmount] = useState(String(initialDelay.amount));
  const [delayUnit, setDelayUnit] = useState<TimeUnit>(initialDelay.unit);
  const [sendAt, setSendAt] = useState(() =>
    toLocalDateTimeInputValue(
      schedule?.kind === 'once_at' ? new Date(schedule.nextRunAt) : new Date(Date.now() + HOUR_MS),
    ),
  );
  const [intervalEvery, setIntervalEvery] = useState(String(initialInterval.amount));
  const [intervalUnit, setIntervalUnit] = useState<TimeUnit>(initialInterval.unit);
  const [maxRunsEnabled, setMaxRunsEnabled] = useState(schedule?.maxRuns != null);
  const [maxRuns, setMaxRuns] = useState(String(schedule?.maxRuns ?? 3));
  const [maxSkipsEnabled, setMaxSkipsEnabled] = useState(schedule?.maxSkips != null);
  const [maxSkips, setMaxSkips] = useState(String(schedule?.maxSkips ?? 12));
  const [stopAtEnabled, setStopAtEnabled] = useState(Boolean(schedule?.stopAt));
  const [stopAt, setStopAt] = useState(() =>
    toLocalDateTimeInputValue(
      schedule?.stopAt ? new Date(schedule.stopAt) : new Date(Date.now() + 24 * HOUR_MS),
    ),
  );
  const [stopWhenTaskNotRunning, setStopWhenTaskNotRunning] = useState(
    schedule?.stopWhenTaskNotRunning ?? true,
  );
  const [messageContent, setMessageContent] = useState(initialContent);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedMessageContent = useMemo(() => messageContent.trim(), [messageContent]);

  const buildSchedulePayload = () => {
    if (mode === 'delay') {
      const amount = parsePositiveInteger(delayAmount);
      if (!amount) return null;
      return {
        mode: 'delay' as const,
        amount,
        unit: delayUnit,
      };
    }

    if (mode === 'at') {
      const sendAtIso = toIsoFromLocalDateTime(sendAt);
      if (!sendAtIso) return null;
      return {
        mode: 'at' as const,
        sendAt: sendAtIso,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    }

    const every = parsePositiveInteger(intervalEvery);
    if (!every) return null;

    const stop: {
      maxRuns?: number;
      maxSkips?: number;
      stopAt?: string;
      stopWhenTaskNotRunning: boolean;
    } = {
      stopWhenTaskNotRunning,
    };
    if (maxRunsEnabled) {
      const value = parsePositiveInteger(maxRuns);
      if (!value) return null;
      stop.maxRuns = value;
    }
    if (maxSkipsEnabled) {
      const value = parsePositiveInteger(maxSkips);
      if (!value) return null;
      stop.maxSkips = value;
    }
    if (stopAtEnabled) {
      const stopAtIso = toIsoFromLocalDateTime(stopAt);
      if (!stopAtIso) return null;
      stop.stopAt = stopAtIso;
    }

    return {
      mode: 'interval' as const,
      every,
      unit: intervalUnit,
      condition: mode === 'idle_interval' ? 'ai_idle' as const : 'none' as const,
      stop,
    };
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedMessageContent) {
      setError('Message content is empty.');
      return;
    }

    const schedulePayload = buildSchedulePayload();
    if (!schedulePayload) {
      setError('Check the schedule values and try again.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const api = getApiClient();
      if (schedule) {
        await api.patch(`/tasks/${taskId}/scheduled-messages/${schedule.id}`, {
          content: trimmedMessageContent,
          schedule: schedulePayload,
        });
        pushToast({
          title: 'Scheduled message updated',
          description: 'The new plan takes effect from now.',
          variant: 'success',
        });
      } else {
        await api.post(`/tasks/${taskId}/scheduled-messages`, {
          content: trimmedMessageContent,
          // A composer draft carries no persisted id, so it schedules with no
          // source message rather than an empty one.
          sourceMessageId: sourceMessageId ? sourceMessageId : null,
          schedule: schedulePayload,
        });
        pushToast({
          title: 'Scheduled message created',
          description: 'The message will be sent by the server at the configured time.',
          variant: 'success',
        });
      }
      onSaved();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : `Failed to ${isEdit ? 'update' : 'create'} scheduled message.`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="flex max-h-[calc(100dvh-14rem)] min-h-0 flex-col sm:max-h-[calc(100dvh-13rem)]" onSubmit={handleSubmit}>
      <div className="-mx-1 min-h-0 space-y-5 overflow-y-auto px-1 pb-4">
        <label className="block space-y-2">
          <span className={labelClassName}>Message Content</span>
          <textarea
            aria-label="Message content"
            value={messageContent}
            onChange={(event) => setMessageContent(event.target.value)}
            rows={5}
            className="webapp-scrollbar max-h-44 min-h-28 w-full resize-y rounded-xl border border-border bg-paper px-3 py-2 text-sm leading-relaxed text-ink outline-none transition-colors focus:border-ink"
          />
        </label>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <button type="button" className={modeButtonClassName(mode === 'delay')} onClick={() => setMode('delay')}>
            Delay
          </button>
          <button type="button" className={modeButtonClassName(mode === 'at')} onClick={() => setMode('at')}>
            Date Time
          </button>
          <button type="button" className={modeButtonClassName(mode === 'interval')} onClick={() => setMode('interval')}>
            Repeat
          </button>
          <button type="button" className={modeButtonClassName(mode === 'idle_interval')} onClick={() => setMode('idle_interval')}>
            If Idle
          </button>
        </div>

        {mode === 'delay' ? (
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <label className="space-y-2">
              <span className={labelClassName}>After</span>
              <input
                className={inputClassName}
                type="number"
                min="1"
                step="1"
                value={delayAmount}
                onChange={(event) => setDelayAmount(event.target.value)}
              />
            </label>
            <label className="space-y-2">
              <span className={labelClassName}>Unit</span>
              <select className={inputClassName} value={delayUnit} onChange={(event) => setDelayUnit(event.target.value as TimeUnit)}>
                <option value="minute">Minutes</option>
                <option value="hour">Hours</option>
              </select>
            </label>
          </div>
        ) : null}

        {mode === 'at' ? (
          <label className="block space-y-2">
            <span className={labelClassName}>Send At</span>
            <input
              className={inputClassName}
              type="datetime-local"
              value={sendAt}
              onChange={(event) => setSendAt(event.target.value)}
            />
          </label>
        ) : null}

        {mode === 'interval' || mode === 'idle_interval' ? (
          <div className="space-y-4">
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <label className="space-y-2">
                <span className={labelClassName}>Every</span>
                <input
                  className={inputClassName}
                  type="number"
                  min="1"
                  step="1"
                  value={intervalEvery}
                  onChange={(event) => setIntervalEvery(event.target.value)}
                />
              </label>
              <label className="space-y-2">
                <span className={labelClassName}>Unit</span>
                <select className={inputClassName} value={intervalUnit} onChange={(event) => setIntervalUnit(event.target.value as TimeUnit)}>
                  <option value="minute">Minutes</option>
                  <option value="hour">Hours</option>
                </select>
              </label>
            </div>

            {mode === 'idle_interval' ? (
              <div className="rounded-xl border border-border bg-paper p-3 text-sm text-muted">
                Sends only when the latest runtime status says the AI reply is idle.
              </div>
            ) : null}

            <div className="space-y-3 rounded-xl border border-border p-3">
              <label className="flex items-center gap-3 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={maxRunsEnabled}
                  onChange={(event) => setMaxRunsEnabled(event.target.checked)}
                />
                <span>Stop after</span>
                <input
                  className="h-9 w-20 rounded-lg border border-border bg-paper px-2 text-sm"
                  type="number"
                  min="1"
                  step="1"
                  value={maxRuns}
                  disabled={!maxRunsEnabled}
                  onChange={(event) => setMaxRuns(event.target.value)}
                />
                <span>sends</span>
              </label>
              <label className="flex items-center gap-3 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={maxSkipsEnabled}
                  onChange={(event) => setMaxSkipsEnabled(event.target.checked)}
                />
                <span>Stop after</span>
                <input
                  className="h-9 w-20 rounded-lg border border-border bg-paper px-2 text-sm"
                  type="number"
                  min="1"
                  step="1"
                  value={maxSkips}
                  disabled={!maxSkipsEnabled}
                  onChange={(event) => setMaxSkips(event.target.value)}
                />
                <span>skips</span>
              </label>
              <label className="grid gap-2 text-sm text-ink">
                <span className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={stopAtEnabled}
                    onChange={(event) => setStopAtEnabled(event.target.checked)}
                  />
                  <span>Stop at</span>
                </span>
                <input
                  className={inputClassName}
                  type="datetime-local"
                  value={stopAt}
                  disabled={!stopAtEnabled}
                  onChange={(event) => setStopAt(event.target.value)}
                />
              </label>
              <label className="flex items-center gap-3 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={stopWhenTaskNotRunning}
                  onChange={(event) => setStopWhenTaskNotRunning(event.target.checked)}
                />
                <span>Stop when task is not running</span>
              </label>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}
      </div>

      <div className="-mx-5 -mb-5 flex shrink-0 justify-end gap-3 border-t border-border bg-panel px-5 py-4">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-border/35"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !trimmedMessageContent}
          className="webapp-gradient-bg rounded-lg px-4 py-2 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting
            ? isEdit ? 'Saving...' : 'Scheduling...'
            : isEdit ? 'Save Changes' : 'Confirm Schedule'}
        </button>
      </div>
    </form>
  );
}
