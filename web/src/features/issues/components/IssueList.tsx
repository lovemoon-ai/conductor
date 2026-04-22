'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Issue, IssueStatus } from '@/shared/types';
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_FILTER_CLASSNAMES,
  ISSUE_STATUS_LABELS,
} from '@/lib/issues/config';
import { buildIssueColumns } from './board-utils';
import { IssueCard } from './IssueCard';

const getVisibleStatuses = (visibleStatuses?: readonly IssueStatus[]): IssueStatus[] => {
  return visibleStatuses && visibleStatuses.length > 0 ? [...visibleStatuses] : [...ISSUE_STATUSES];
};

const getDefaultVisibleStatus = (issues: Issue[], visibleStatuses?: readonly IssueStatus[]): Issue['status'] => {
  const columns = buildIssueColumns(issues);
  const statusOptions = getVisibleStatuses(visibleStatuses);
  return statusOptions.find((status) => columns[status].length > 0) ?? statusOptions[0];
};

export function IssueList({
  issues,
  visibleStatuses,
  onStatusChange,
  onDeleteIssue,
}: {
  issues: Issue[];
  visibleStatuses?: readonly IssueStatus[];
  onStatusChange?: (issueId: string, status: Issue['status']) => Promise<void> | void;
  onDeleteIssue?: (issueId: string) => Promise<void> | void;
}) {
  const statusOptions = useMemo(() => getVisibleStatuses(visibleStatuses), [visibleStatuses]);
  const columns = useMemo(() => buildIssueColumns(issues), [issues]);
  const defaultVisibleStatus = useMemo(
    () => getDefaultVisibleStatus(issues, statusOptions),
    [issues, statusOptions],
  );
  const [visibleStatus, setVisibleStatus] = useState<Issue['status']>(defaultVisibleStatus);
  const [hasCustomizedFilter, setHasCustomizedFilter] = useState(false);

  useEffect(() => {
    if (!hasCustomizedFilter || !statusOptions.includes(visibleStatus)) {
      setVisibleStatus(defaultVisibleStatus);
    }
  }, [defaultVisibleStatus, hasCustomizedFilter, statusOptions, visibleStatus]);

  const visibleIssues = columns[visibleStatus] ?? [];

  const handleToggleStatus = (status: Issue['status']) => {
    setHasCustomizedFilter(true);
    setVisibleStatus(status);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto webapp-scrollbar">
      <div className="sticky top-0 z-40 mb-3 bg-paper/90 pb-2 pt-0.5 backdrop-blur-xl">
        <div className="flex gap-2 overflow-x-auto webapp-scrollbar">
          {statusOptions.map((status) => {
            const selected = visibleStatus === status;
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

      {visibleIssues.length > 0 ? (
        <div className="space-y-3 pb-1">
          {visibleIssues.map((issue) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              disabled
              onStatusChange={onStatusChange}
              onDelete={onDeleteIssue}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-[22px] border border-dashed border-border bg-panel/45 px-4 py-6 text-center text-sm text-muted/75">
          No issues in {ISSUE_STATUS_LABELS[visibleStatus]}.
        </div>
      )}
    </div>
  );
}
