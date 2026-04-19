'use client';

import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Issue, IssueStatus } from '@/shared/types';
import {
  ISSUE_STATUS_COLUMN_CLASSNAMES,
  ISSUE_STATUS_LABELS,
  ISSUE_STATUS_TITLE_CLASSNAMES,
} from '@/lib/issues/config';
import { IssueCard } from './IssueCard';

export function IssueColumn({
  status,
  issues,
  dragDisabled = false,
  statusMenuDisabled = false,
  onStatusChange,
  onDeleteIssue,
}: {
  status: IssueStatus;
  issues: Issue[];
  dragDisabled?: boolean;
  statusMenuDisabled?: boolean;
  onStatusChange?: (issueId: string, status: Issue['status']) => Promise<void> | void;
  onDeleteIssue?: (issueId: string) => Promise<void> | void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <section className={`flex h-full min-h-[26rem] flex-col rounded-[28px] border ${ISSUE_STATUS_COLUMN_CLASSNAMES[status]} p-3`}>
      <header className="mb-3 px-1">
        <h2 className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] ${ISSUE_STATUS_TITLE_CLASSNAMES[status]}`}>
          {ISSUE_STATUS_LABELS[status]}{issues.length > 0 ? `(${issues.length})` : ''}
        </h2>
      </header>

      <SortableContext items={issues.map((issue) => issue.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={`flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-[22px] p-1 transition-colors webapp-scrollbar ${
            isOver ? 'bg-accent/6' : ''
          }`}
          data-status-column={status}
        >
          {issues.length > 0 ? (
            issues.map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                disabled={dragDisabled}
                statusMenuDisabled={statusMenuDisabled}
                onStatusChange={onStatusChange}
                onDelete={onDeleteIssue}
              />
            ))
          ) : (
            <div className="flex min-h-[8rem] flex-1 items-center justify-center rounded-[22px] border border-dashed border-border/80 bg-panel/40 px-4 text-center text-sm text-muted/70">
              Drop issues here
            </div>
          )}
        </div>
      </SortableContext>
    </section>
  );
}
