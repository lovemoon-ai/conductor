import type { Issue, IssueStatus } from '@/shared/types';
import { ISSUE_STATUSES, normalizeIssueStatus } from '@/lib/issues/config';

export type IssueBoardColumns = Record<IssueStatus, Issue[]>;

const toTimestamp = (value: string | null | undefined): number => {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const createEmptyIssueColumns = (): IssueBoardColumns => ({
  backlog: [],
  todo: [],
  doing: [],
  review: [],
  done: [],
});

export const sortIssuesForBoard = (issues: Issue[]): Issue[] => {
  return issues.slice().sort((left, right) => {
    const leftStatusIndex = ISSUE_STATUSES.indexOf(normalizeIssueStatus(left.status));
    const rightStatusIndex = ISSUE_STATUSES.indexOf(normalizeIssueStatus(right.status));
    if (leftStatusIndex !== rightStatusIndex) {
      return leftStatusIndex - rightStatusIndex;
    }
    if (left.position !== right.position) {
      return left.position - right.position;
    }
    return toTimestamp(right.updatedAt ?? right.createdAt) - toTimestamp(left.updatedAt ?? left.createdAt);
  });
};

export const buildIssueColumns = (issues: Issue[]): IssueBoardColumns => {
  const columns = createEmptyIssueColumns();
  for (const issue of sortIssuesForBoard(issues)) {
    columns[normalizeIssueStatus(issue.status)].push(issue);
  }
  return columns;
};

export const findIssueStatus = (
  columns: IssueBoardColumns,
  entryId: string | null | undefined,
): IssueStatus | null => {
  if (!entryId) {
    return null;
  }
  if (ISSUE_STATUSES.includes(entryId as IssueStatus)) {
    return entryId as IssueStatus;
  }
  for (const status of ISSUE_STATUSES) {
    if (columns[status].some((issue) => issue.id === entryId)) {
      return status;
    }
  }
  return null;
};

export const moveIssueLocally = (
  columns: IssueBoardColumns,
  activeId: string,
  overId: string,
): IssueBoardColumns => {
  if (!activeId || !overId || activeId === overId) {
    return columns;
  }

  const sourceStatus = findIssueStatus(columns, activeId);
  const targetStatus = findIssueStatus(columns, overId);
  if (!sourceStatus || !targetStatus) {
    return columns;
  }

  const sourceItems = columns[sourceStatus];
  const targetItems = columns[targetStatus];
  const activeIssue = sourceItems.find((issue) => issue.id === activeId);
  if (!activeIssue) {
    return columns;
  }

  const nextSourceItems = sourceItems.filter((issue) => issue.id !== activeId);
  const nextTargetItemsBase =
    sourceStatus === targetStatus
      ? nextSourceItems
      : targetItems.filter((issue) => issue.id !== activeId);
  const targetIndex = ISSUE_STATUSES.includes(overId as IssueStatus)
    ? nextTargetItemsBase.length
    : nextTargetItemsBase.findIndex((issue) => issue.id === overId);
  const insertionIndex = targetIndex >= 0 ? targetIndex : nextTargetItemsBase.length;
  const movedIssue = { ...activeIssue, status: targetStatus };
  const nextTargetItems = [...nextTargetItemsBase];
  nextTargetItems.splice(insertionIndex, 0, movedIssue);

  if (sourceStatus === targetStatus) {
    const hasChanged = nextTargetItems.some((issue, index) => issue.id !== sourceItems[index]?.id);
    if (!hasChanged) {
      return columns;
    }
    return {
      ...columns,
      [sourceStatus]: nextTargetItems,
    };
  }

  return {
    ...columns,
    [sourceStatus]: nextSourceItems,
    [targetStatus]: nextTargetItems,
  };
};

export const calculateIssuePosition = (issues: Issue[], issueId: string): number => {
  const index = issues.findIndex((issue) => issue.id === issueId);
  if (index === -1) {
    return 0;
  }

  const previousIssue = index > 0 ? issues[index - 1] : null;
  const nextIssue = index < issues.length - 1 ? issues[index + 1] : null;

  if (!previousIssue && !nextIssue) {
    return 0;
  }
  if (!previousIssue) {
    return (nextIssue?.position ?? 0) - 1;
  }
  if (!nextIssue) {
    return previousIssue.position + 1;
  }

  const midpoint = previousIssue.position + (nextIssue.position - previousIssue.position) / 2;
  if (
    Number.isFinite(midpoint)
    && midpoint > previousIssue.position
    && midpoint < nextIssue.position
  ) {
    return midpoint;
  }

  return previousIssue.position + 0.5;
};

export const calculateIssueAppendPosition = (
  issues: Issue[],
  status: IssueStatus,
  excludeIssueId?: string,
): number => {
  const columnIssues = buildIssueColumns(
    excludeIssueId ? issues.filter((issue) => issue.id !== excludeIssueId) : issues,
  )[status];
  const lastIssue = columnIssues[columnIssues.length - 1];
  return lastIssue ? lastIssue.position + 1 : 0;
};
