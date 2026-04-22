import { describe, expect, it } from 'vitest';
import type { Issue } from '@/shared/types';
import { calculateIssuePositionFromPlacement } from './board-utils';

const buildIssue = (overrides: Partial<Issue>): Issue => ({
  id: 'issue',
  projectId: 'project-1',
  title: 'Issue',
  description: null,
  status: 'doing',
  position: 0,
  createdAt: '2026-04-14T00:00:00.000Z',
  updatedAt: '2026-04-14T00:00:00.000Z',
  ...overrides,
});

describe('board-utils', () => {
  it('uses the current next neighbor for a trailing anchor when new issues were inserted', () => {
    const issues = [
      buildIssue({ id: 'issue-1', status: 'todo', position: 0 }),
      buildIssue({ id: 'issue-2', position: 10 }),
      buildIssue({ id: 'issue-3', position: 11 }),
    ];

    expect(calculateIssuePositionFromPlacement(issues, 'doing', {
      mode: 'anchors',
      anchors: {
        previousIssueId: 'issue-2',
        nextIssueId: null,
      },
    }, 'issue-1')).toBe(10.5);
  });

  it('uses the current previous neighbor for a leading anchor when new issues were inserted', () => {
    const issues = [
      buildIssue({ id: 'issue-1', status: 'todo', position: 0 }),
      buildIssue({ id: 'issue-3', position: 9 }),
      buildIssue({ id: 'issue-2', position: 10 }),
    ];

    expect(calculateIssuePositionFromPlacement(issues, 'doing', {
      mode: 'anchors',
      anchors: {
        previousIssueId: null,
        nextIssueId: 'issue-2',
      },
    }, 'issue-1')).toBe(9.5);
  });
});
