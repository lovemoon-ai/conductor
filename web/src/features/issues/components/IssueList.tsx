'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Issue } from '@/shared/types';
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_FILTER_CLASSNAMES,
  ISSUE_STATUS_LABELS,
} from '@/lib/issues/config';
import { buildIssueColumns } from './board-utils';
import { IssueCard } from './IssueCard';

const getDefaultVisibleStatuses = (issues: Issue[]): Issue['status'][] => {
  const columns = buildIssueColumns(issues);
  const nonEmptyStatuses = ISSUE_STATUSES.filter((status) => columns[status].length > 0);
  return nonEmptyStatuses.length > 0 ? nonEmptyStatuses : [...ISSUE_STATUSES];
};

export function IssueList({
  issues,
  onStatusChange,
  onDeleteIssue,
}: {
  issues: Issue[];
  onStatusChange?: (issueId: string, status: Issue['status']) => Promise<void> | void;
  onDeleteIssue?: (issueId: string) => Promise<void> | void;
}) {
  const columns = useMemo(() => buildIssueColumns(issues), [issues]);
  const defaultVisibleStatuses = useMemo(() => getDefaultVisibleStatuses(issues), [issues]);
  const [visibleStatuses, setVisibleStatuses] = useState<Issue['status'][]>(defaultVisibleStatuses);
  const [hasCustomizedFilters, setHasCustomizedFilters] = useState(false);

  useEffect(() => {
    if (!hasCustomizedFilters) {
      setVisibleStatuses(defaultVisibleStatuses);
    }
  }, [defaultVisibleStatuses, hasCustomizedFilters]);

  const visibleSections = ISSUE_STATUSES.filter((status) => visibleStatuses.includes(status));

  const handleToggleStatus = (status: Issue['status']) => {
    setHasCustomizedFilters(true);
    setVisibleStatuses((current) => {
      if (current.includes(status)) {
        return current.filter((entry) => entry !== status);
      }
      return ISSUE_STATUSES.filter((entry) => current.includes(entry) || entry === status);
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto webapp-scrollbar">
      <div className="sticky top-0 z-40 mb-3 bg-paper/90 pb-2 pt-0.5 backdrop-blur-xl">
        <div className="flex gap-2 overflow-x-auto webapp-scrollbar">
          {ISSUE_STATUSES.map((status) => {
            const selected = visibleStatuses.includes(status);
            return (
              <button
                key={status}
                type="button"
                aria-pressed={selected}
                onClick={() => handleToggleStatus(status)}
                className={[
                  'shrink-0 rounded-full border border-transparent px-3 py-1.5 text-xs font-medium transition-colors',
                  selected
                    ? ISSUE_STATUS_FILTER_CLASSNAMES[status]
                    : 'bg-transparent text-muted/80',
                ].join(' ')}
              >
                {ISSUE_STATUS_LABELS[status]}{columns[status].length > 0 ? `(${columns[status].length})` : ''}
              </button>
            );
          })}
        </div>
      </div>

      {visibleSections.length > 0 ? (
        <div className="space-y-3 pb-1">
          {visibleSections.map((status) => {
            const columnIssues = columns[status];
            return (
              columnIssues.length > 0 ? (
                <section key={status} className="space-y-2">
                  <div className="space-y-2">
                    {columnIssues.map((issue) => (
                      <IssueCard
                        key={issue.id}
                        issue={issue}
                        disabled
                        onStatusChange={onStatusChange}
                        onDelete={onDeleteIssue}
                      />
                    ))}
                  </div>
                </section>
              ) : null
            );
          })}
        </div>
      ) : (
        <div className="rounded-[22px] border border-dashed border-border bg-panel/45 px-4 py-6 text-center text-sm text-muted/75">
          Select at least one status to show issues.
        </div>
      )}
    </div>
  );
}
