'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Issue } from '@/shared/types';
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_FILTER_CLASSNAMES,
  ISSUE_STATUS_LABELS,
} from '@/lib/issues/config';
import { buildIssueColumns } from './board-utils';
import { IssueCard, type IssueOwnerOption } from './IssueCard';
import { IssueDetailsDialog } from './IssueDetailsDialog';

const getDefaultVisibleStatus = (issues: Issue[]): Issue['status'] => {
  const columns = buildIssueColumns(issues);
  return ISSUE_STATUSES.find((status) => columns[status].length > 0) ?? ISSUE_STATUSES[0];
};

export function IssueList({
  issues,
  onStatusChange,
  ownerOptionsByProjectId,
  onDeleteIssue,
}: {
  issues: Issue[];
  onStatusChange?: (issueId: string, status: Issue['status']) => Promise<void> | void;
  ownerOptionsByProjectId?: Map<string, IssueOwnerOption[]>;
  onDeleteIssue?: (issueId: string) => Promise<void> | void;
}) {
  const columns = useMemo(() => buildIssueColumns(issues), [issues]);
  const defaultVisibleStatus = useMemo(() => getDefaultVisibleStatus(issues), [issues]);
  const [visibleStatus, setVisibleStatus] = useState<Issue['status']>(defaultVisibleStatus);
  const [hasCustomizedFilter, setHasCustomizedFilter] = useState(false);
  const [detailsIssueId, setDetailsIssueId] = useState<string | null>(null);

  const handleOpenDetails = useCallback((issue: Issue) => {
    setDetailsIssueId(issue.id);
  }, []);

  const handleCloseDetails = useCallback(() => {
    setDetailsIssueId(null);
  }, []);

  const detailsIssue = useMemo(
    () => (detailsIssueId ? issues.find((issue) => issue.id === detailsIssueId) ?? null : null),
    [detailsIssueId, issues],
  );
  const detailsOwnerOptions = detailsIssue ? ownerOptionsByProjectId?.get(detailsIssue.projectId) : undefined;

  useEffect(() => {
    if (!hasCustomizedFilter) {
      setVisibleStatus(defaultVisibleStatus);
    }
  }, [defaultVisibleStatus, hasCustomizedFilter]);

  const visibleIssues = columns[visibleStatus];

  const handleToggleStatus = (status: Issue['status']) => {
    setHasCustomizedFilter(true);
    setVisibleStatus(status);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto webapp-scrollbar">
      <div className="sticky top-0 z-40 mb-3 bg-paper/90 pb-2 pt-0.5 backdrop-blur-xl">
        <div className="flex gap-2 overflow-x-auto webapp-scrollbar">
          {ISSUE_STATUSES.map((status) => {
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
              ownerOptions={ownerOptionsByProjectId?.get(issue.projectId)}
              onDelete={onDeleteIssue}
              onOpenDetails={handleOpenDetails}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-[22px] border border-dashed border-border bg-panel/45 px-4 py-6 text-center text-sm text-muted/75">
          No issues in {ISSUE_STATUS_LABELS[visibleStatus]}.
        </div>
      )}

      <IssueDetailsDialog
        open={Boolean(detailsIssue)}
        onClose={handleCloseDetails}
        issue={detailsIssue}
        ownerOptions={detailsOwnerOptions}
      />
    </div>
  );
}
