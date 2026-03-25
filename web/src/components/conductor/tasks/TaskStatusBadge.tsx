'use client';

import type { TaskStatus } from '@/lib/conductor/types';

interface TaskStatusBadgeProps {
  status: TaskStatus;
  labelOverride?: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  tone?: 'default' | 'danger' | 'warning';
}

export function TaskStatusBadge({
  status,
  labelOverride,
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
  const label = labelOverride ?? config.label;
  const toneClassName =
    tone === 'danger'
      ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
      : tone === 'warning'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
      : `${config.bg} ${config.text}`;
  const className = `inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-medium ${toneClassName}`;

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
        title={title ?? label}
        aria-label={label}
        className={`${className} transition-colors hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-70`}
      >
        {status === 'running' && !labelOverride ? (
          <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
        ) : null}
        {label}
      </button>
    );
  }

  return (
    <span
      className={className}
      title={title ?? label}
    >
      {status === 'running' && (
        <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
      )}
      {label}
    </span>
  );
}
