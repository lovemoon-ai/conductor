'use client';

import type { TaskStatus } from '@/lib/conductor/types';

interface TaskStatusBadgeProps {
  status: TaskStatus;
}

export function TaskStatusBadge({ status }: TaskStatusBadgeProps) {
  const statusConfig: Record<TaskStatus, { bg: string; text: string; label: string }> = {
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

  return (
    <span
      className={`inline-flex items-center px-2.5 py-1 text-xs font-medium rounded-lg ${config.bg} ${config.text}`}
    >
      {status === 'running' && (
        <span className="w-1.5 h-1.5 mr-1.5 rounded-full bg-current animate-pulse" />
      )}
      {config.label}
    </span>
  );
}
