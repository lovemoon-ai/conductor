'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getApiClient } from '@/shared/api/client';
import type { AchievedTasksPage } from '@/shared/types';

export const ACHIEVED_TASKS_PATH = '/app/settings/achieved-tasks';

export function AchievedTaskSettingsCard() {
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getApiClient()
      .get<Partial<AchievedTasksPage>>('/tasks/achieved?page=1&limit=1')
      .then((response) => {
        if (cancelled) return;
        setTotal(typeof response?.total === 'number' ? response.total : 0);
        setError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setTotal(null);
        setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="webapp-card p-5" data-testid="achieved-tasks-settings-card">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)]/10 text-[var(--accent)]">
          <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v1a2 2 0 01-2 2M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8M10 12h4" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-semibold">Achieved tasks</h3>
          <p className="text-sm text-muted" aria-live="polite">
            {error
              ? 'Archived task count unavailable'
              : total === null
                ? 'Loading archived task count...'
                : `${total} archived ${total === 1 ? 'task' : 'tasks'}`}
          </p>
        </div>
        <Link
          href={ACHIEVED_TASKS_PATH}
          className="shrink-0 rounded-lg border border-border px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-[var(--accent)]/40 hover:bg-[var(--accent)]/5"
        >
          View tasks
        </Link>
      </div>
    </section>
  );
}
