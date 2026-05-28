'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { Issue } from '@/shared/types';
import { ISSUE_STATUSES } from '@/lib/issues/config';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { IssueCardOverlay, type IssueOwnerOption } from './IssueCard';
import { IssueColumn } from './IssueColumn';
import { IssueDetailsDialog } from './IssueDetailsDialog';
import {
  buildIssueColumns,
  calculateIssuePosition,
  findIssueStatus,
  getIssueMovePlacement,
  moveIssueLocally,
  type IssueBoardColumns,
  type IssueMovePlacement,
} from './board-utils';

const collisionDetection: CollisionDetection = (args) => {
  const pointerIntersections = pointerWithin(args);
  if (pointerIntersections.length > 0) {
    return pointerIntersections;
  }
  return closestCenter(args);
};

export function IssueBoard({
  issues,
  isLoading = false,
  dragDisabled = false,
  statusMenuDisabled = false,
  onMoveIssue,
  onStatusChange,
  ownerOptionsByProjectId,
  multiDaemonProjectIds,
  onDeleteIssue,
}: {
  issues: Issue[];
  isLoading?: boolean;
  dragDisabled?: boolean;
  statusMenuDisabled?: boolean;
  onMoveIssue: (
    issueId: string,
    status: Issue['status'],
    position: number,
    placement?: IssueMovePlacement,
  ) => Promise<boolean | void> | boolean | void;
  onStatusChange?: (issueId: string, status: Issue['status']) => Promise<void> | void;
  ownerOptionsByProjectId?: Map<string, IssueOwnerOption[]>;
  multiDaemonProjectIds?: ReadonlySet<string>;
  onDeleteIssue?: (issueId: string) => Promise<void> | void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const effectiveDragDisabled = isLoading || dragDisabled;
  const effectiveStatusMenuDisabled = isLoading || statusMenuDisabled;
  const baseColumns = useMemo(() => buildIssueColumns(issues), [issues]);
  const issuesKey = useMemo(() => JSON.stringify(issues), [issues]);
  const [boardDraft, setBoardDraft] = useState<{ sourceKey: string; columns: IssueBoardColumns } | null>(null);
  const [activeIssueId, setActiveIssueId] = useState<string | null>(null);
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

  const columns = useMemo(() => {
    if (!boardDraft) {
      return baseColumns;
    }
    if (activeIssueId === null && boardDraft.sourceKey !== issuesKey) {
      return baseColumns;
    }
    return boardDraft.columns;
  }, [activeIssueId, baseColumns, boardDraft, issuesKey]);

  const activeIssue = useMemo(() => {
    if (!activeIssueId) {
      return null;
    }
    return issues.find((issue) => issue.id === activeIssueId)
      ?? Object.values(columns).flat().find((issue) => issue.id === activeIssueId)
      ?? null;
  }, [activeIssueId, columns, issues]);
  const activeOwnerOptions = activeIssue ? ownerOptionsByProjectId?.get(activeIssue.projectId) : undefined;

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveIssueId(String(event.active.id));
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (!event.over) {
      return;
    }

    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    const currentColumns = boardDraft?.sourceKey === issuesKey ? boardDraft.columns : baseColumns;
    setBoardDraft({
      sourceKey: issuesKey,
      columns: moveIssueLocally(currentColumns, activeId, overId),
    });
  }, [baseColumns, boardDraft, issuesKey]);

  const handleDragCancel = useCallback((_event: DragCancelEvent) => {
    setActiveIssueId(null);
    setBoardDraft(null);
  }, []);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const previousIssue = issues.find((issue) => issue.id === activeId) ?? null;
    const currentColumns = boardDraft?.sourceKey === issuesKey ? boardDraft.columns : baseColumns;
    const nextColumns = event.over
      ? moveIssueLocally(currentColumns, activeId, String(event.over.id))
      : baseColumns;

    setBoardDraft(event.over ? { sourceKey: issuesKey, columns: nextColumns } : null);
    setActiveIssueId(null);

    if (!event.over || !previousIssue) {
      return;
    }

    const nextStatus = findIssueStatus(nextColumns, activeId);
    if (!nextStatus) {
      return;
    }

    const nextColumn = nextColumns[nextStatus];
    const projectScopedNextColumn = nextColumn.filter(
      (issue) => issue.id === activeId || issue.projectId === previousIssue.projectId,
    );
    const nextPosition = calculateIssuePosition(projectScopedNextColumn, activeId);
    const nextPlacement = getIssueMovePlacement(projectScopedNextColumn, activeId);
    const statusChanged = previousIssue.status !== nextStatus;
    const positionChanged = Math.abs(previousIssue.position - nextPosition) > 1e-9;

    if (!statusChanged && !positionChanged) {
      return;
    }

    try {
      const accepted = await onMoveIssue(activeId, nextStatus, nextPosition, nextPlacement);
      if (accepted === false) {
        setBoardDraft(null);
      }
    } catch {
      setBoardDraft(null);
    }
  }, [baseColumns, boardDraft, issues, issuesKey, onMoveIssue]);

  if (isLoading && issues.length === 0) {
    return (
      <div className="flex h-full min-h-[24rem] items-center justify-center rounded-[28px] border border-border bg-panel/60">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-full min-h-0 gap-4 overflow-x-auto pb-2 webapp-scrollbar">
        {ISSUE_STATUSES.map((status) => (
          <div key={status} className="min-h-0 w-[18.5rem] min-w-[18.5rem] lg:w-[19rem] xl:flex-1">
            <IssueColumn
              status={status}
              issues={columns[status]}
              dragDisabled={effectiveDragDisabled}
              statusMenuDisabled={effectiveStatusMenuDisabled}
              onStatusChange={onStatusChange}
              ownerOptionsByProjectId={ownerOptionsByProjectId}
              multiDaemonProjectIds={multiDaemonProjectIds}
              onDeleteIssue={onDeleteIssue}
              onOpenDetails={handleOpenDetails}
            />
          </div>
        ))}
      </div>

      <DragOverlay>
        {activeIssue ? (
          <IssueCardOverlay
            issue={activeIssue}
            ownerOptions={activeOwnerOptions}
            multiDaemonContext={multiDaemonProjectIds?.has(activeIssue.projectId) ?? false}
          />
        ) : null}
      </DragOverlay>

      <IssueDetailsDialog
        open={Boolean(detailsIssue)}
        onClose={handleCloseDetails}
        issue={detailsIssue}
        ownerOptions={detailsOwnerOptions}
      />
    </DndContext>
  );
}
