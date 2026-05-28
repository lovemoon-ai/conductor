'use client';

import { useEffect, useMemo, useState } from 'react';
import type { TaskStatus } from '@/shared/types';

const DEFAULT_KILLING_TIMEOUT_MS = 60_000;

interface TaskStatusBadgeProps {
  status: TaskStatus;
  labelOverride?: string;
  statusStartedAt?: string | null;
  timeoutMs?: number | null;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  tone?: 'default' | 'danger' | 'warning';
}

export function TaskStatusBadge({
  status,
  labelOverride,
  statusStartedAt,
  timeoutMs,
  onClick,
  disabled = false,
  title,
  tone = 'default',
}: TaskStatusBadgeProps) {
  const statusConfig: Record<TaskStatus, { bg: string; text: string; label: string }> = {
    init: {
      bg: 'bg-sky-100 dark:bg-sky-900/30',
      text: 'text-sky-700 dark:text-sky-300',
      label: 'init',
    },
    running: {
      bg: 'bg-green-100 dark:bg-green-900/30',
      text: 'text-green-700 dark:text-green-400',
      label: 'running',
    },
    killing: {
      bg: 'bg-amber-100 dark:bg-amber-900/30',
      text: 'text-amber-800 dark:text-amber-300',
      label: 'killing',
    },
    killed: {
      bg: 'bg-slate-100 dark:bg-slate-800',
      text: 'text-slate-600 dark:text-slate-400',
      label: 'killed',
    },
    unknown: {
      bg: 'bg-slate-100 dark:bg-slate-800',
      text: 'text-slate-600 dark:text-slate-400',
      label: 'unknown',
    },
    completed: {
      bg: 'bg-green-100 dark:bg-green-900/30',
      text: 'text-green-600 dark:text-green-400',
      label: 'completed',
    },
  };

  const config = statusConfig[status] || statusConfig.unknown;
  const killingStartedAtMs = useMemo(() => {
    if (status !== 'killing' || !statusStartedAt) {
      return null;
    }
    const parsed = Date.parse(statusStartedAt);
    return Number.isFinite(parsed) ? parsed : null;
  }, [status, statusStartedAt]);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (status !== 'killing') {
      return;
    }
    const interval = window.setInterval(() => {
      setTick((tick) => tick + 1);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [status]);

  const effectiveTimeoutMs =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_KILLING_TIMEOUT_MS;
  const nowMs = status === 'killing' ? Date.now() : null;
  const killingElapsedMs =
    status === 'killing'
      ? Math.max(0, (nowMs ?? 0) - (killingStartedAtMs ?? (nowMs ?? 0)))
      : 0;
  const killingElapsedSeconds = Math.floor(killingElapsedMs / 1000);
  const killingTimedOut = status === 'killing' && killingElapsedSeconds * 1000 >= effectiveTimeoutMs;
  const killingDisplaySeconds = Math.min(killingElapsedSeconds, Math.ceil(effectiveTimeoutMs / 1000));
  const label =
    labelOverride ??
    (status === 'killing'
      ? killingTimedOut
        ? `killing ${killingDisplaySeconds}s timeout`
        : `killing ${killingDisplaySeconds}s`
      : config.label);
  const resolvedTitle =
    title ??
    (status === 'killing'
      ? killingTimedOut
        ? `Killing timed out after ${Math.ceil(effectiveTimeoutMs / 1000)}s`
        : `Killing for ${killingDisplaySeconds}s`
      : label);
  const toneClassName =
    tone === 'danger'
      ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
      : tone === 'warning'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
        : status === 'killing' && killingTimedOut
          ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
        : `${config.bg} ${config.text}`;
  const className = `inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-medium ${toneClassName}`;
  const shouldPulse = (status === 'running' || status === 'killing') && !labelOverride;

  if (onClick) {
    return (
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick();
        }}
        disabled={disabled}
        title={resolvedTitle}
        aria-label={label}
        className={`${className} transition-colors hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-70`}
      >
        {shouldPulse ? (
          <span className="mr-1.5 size-1.5 rounded-full bg-current animate-pulse" />
        ) : null}
        {label}
      </button>
    );
  }

  return (
    <span
      className={className}
      title={resolvedTitle}
    >
      {shouldPulse && (
        <span className="mr-1.5 size-1.5 rounded-full bg-current animate-pulse" />
      )}
      {label}
    </span>
  );
}
