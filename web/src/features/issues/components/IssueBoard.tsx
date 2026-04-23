'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { IssueCardOverlay } from './IssueCard';
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
  onDeleteIssue?: (issueId: string) => Promise<void> | void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const effectiveDragDisabled = isLoading || dragDisabled;
  const effectiveStatusMenuDisabled = isLoading || statusMenuDisabled;
  const [columns, setColumns] = useState<IssueBoardColumns>(() => buildIssueColumns(issues));
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

  useEffect(() => {
    if (activeIssueId !== null) {
      return;
    }
    setColumns(buildIssueColumns(issues));
  }, [issues]);

  const activeIssue = useMemo(() => {
    if (!activeIssueId) {
      return null;
    }
    return issues.find((issue) => issue.id === activeIssueId)
      ?? Object.values(columns).flat().find((issue) => issue.id === activeIssueId)
      ?? null;
  }, [activeIssueId, columns, issues]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveIssueId(String(event.active.id));
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (!event.over) {
      return;
    }

    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    setColumns((current) => moveIssueLocally(current, activeId, overId));
  }, []);

  const handleDragCancel = useCallback((_event: DragCancelEvent) => {
    setActiveIssueId(null);
    setColumns(buildIssueColumns(issues));
  }, [issues]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const previousIssue = issues.find((issue) => issue.id === activeId) ?? null;
    const nextColumns = event.over
      ? moveIssueLocally(columns, activeId, String(event.over.id))
      : buildIssueColumns(issues);

    setColumns(nextColumns);
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
        setColumns(buildIssueColumns(issues));
      }
    } catch {
      setColumns(buildIssueColumns(issues));
    }
  }, [columns, issues, onMoveIssue]);

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
              onDeleteIssue={onDeleteIssue}
              onOpenDetails={handleOpenDetails}
            />
          </div>
        ))}
      </div>

      <DragOverlay>
        {activeIssue ? <IssueCardOverlay issue={activeIssue} /> : null}
      </DragOverlay>

      <IssueDetailsDialog
        open={Boolean(detailsIssue)}
        onClose={handleCloseDetails}
        issue={detailsIssue}
      />
    </DndContext>
  );
}
