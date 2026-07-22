import { describe, expect, it } from 'vitest';
import {
  addTaskToGroup,
  buildTaskCardRows,
  createTaskCardGroup,
  ejectTaskFromGroup,
  maxTaskCardGroupIdCounter,
  projectTaskCardGroups,
  readTaskCardGroups,
  setActiveTaskCardTab,
  setTaskCardTabLabel,
  taskCardTabLabel,
  type TaskCardGroup,
} from './task-card-groups';

const group = (over: Partial<TaskCardGroup> & Pick<TaskCardGroup, 'id' | 'taskIds'>): TaskCardGroup => ({
  activeIndex: 0,
  labels: {},
  ...over,
});

describe('task-card-groups', () => {
  describe('readTaskCardGroups', () => {
    it('drops groups with fewer than two valid tasks', () => {
      expect(readTaskCardGroups([{ id: 'g1', taskIds: ['a'] }])).toEqual([]);
      expect(readTaskCardGroups('nope')).toEqual([]);
    });

    it('enforces single-group membership and clamps activeIndex', () => {
      const parsed = readTaskCardGroups([
        { id: 'g1', taskIds: ['a', 'b', 'a'], activeIndex: 9, labels: { a: 'X', z: 'Y' } },
        { id: 'g2', taskIds: ['b', 'c'] }, // 'b' already claimed by g1 → g2 has only 'c' → dropped
      ]);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].taskIds).toEqual(['a', 'b']);
      expect(parsed[0].activeIndex).toBe(1);
      expect(parsed[0].labels).toEqual({ a: 'X' });
    });
  });

  describe('projectTaskCardGroups', () => {
    it('hides tabs for filtered-out tasks and dissolves to <2 live tabs', () => {
      const groups = [group({ id: 'g1', taskIds: ['a', 'b', 'c'], activeIndex: 1 })];
      const live = new Set(['a', 'c']);
      const [rg] = projectTaskCardGroups(groups, (id) => live.has(id));
      expect(rg.taskIds).toEqual(['a', 'c']);
      // active 'b' is gone → falls back to first live tab
      expect(rg.activeTaskId).toBe('a');
      // ordinals keep original positions so numbering stays stable
      expect(rg.ordinals).toEqual({ a: 0, b: 1, c: 2 });
      expect(taskCardTabLabel(rg, 'c')).toBe('2');

      const gone = projectTaskCardGroups(groups, (id) => id === 'a');
      expect(gone).toEqual([]);
    });
  });

  describe('buildTaskCardRows', () => {
    it('emits a group once at its first member position', () => {
      const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
      const [rg] = projectTaskCardGroups(
        [group({ id: 'g1', taskIds: ['b', 'd'] })],
        () => true,
      );
      const rows = buildTaskCardRows(tasks, [rg]);
      expect(rows.map((r) => (r.type === 'task' ? r.task.id : `group:${r.group.id}`)))
        .toEqual(['a', 'group:g1', 'c']);
    });
  });

  describe('mutators', () => {
    it('creates a group with the dragged tab active', () => {
      const next = createTaskCardGroup([], 'tabcard-1', 'a', 'b');
      expect(next).toEqual([
        { id: 'tabcard-1', taskIds: ['a', 'b'], activeIndex: 1, labels: {} },
      ]);
    });

    it('moves a task out of its old group when merged elsewhere', () => {
      const groups = [group({ id: 'g1', taskIds: ['a', 'b', 'c'], activeIndex: 2 })];
      // drag 'c' onto lone task 'd'
      const next = createTaskCardGroup(groups, 'tabcard-2', 'd', 'c');
      const g1 = next.find((g) => g.id === 'g1')!;
      expect(g1.taskIds).toEqual(['a', 'b']);
      expect(g1.activeIndex).toBe(0); // active 'c' left, reset
      const g2 = next.find((g) => g.id === 'tabcard-2')!;
      expect(g2.taskIds).toEqual(['d', 'c']);
    });

    it('appends a dragged task as the active tab', () => {
      const groups = [group({ id: 'g1', taskIds: ['a', 'b'] })];
      const next = addTaskToGroup(groups, 'g1', 'c');
      expect(next[0].taskIds).toEqual(['a', 'b', 'c']);
      expect(next[0].activeIndex).toBe(2);
    });

    it('switches and renames tabs', () => {
      let groups = [group({ id: 'g1', taskIds: ['a', 'b'], activeIndex: 1 })];
      groups = setActiveTaskCardTab(groups, 'g1', 'a');
      expect(groups[0].activeIndex).toBe(0);
      groups = setTaskCardTabLabel(groups, 'g1', 'a', '  Design  ');
      expect(groups[0].labels.a).toBe('Design');
      groups = setTaskCardTabLabel(groups, 'g1', 'a', '   ');
      expect(groups[0].labels.a).toBeUndefined();
    });

    it('ejects a tab and dissolves at <2 tabs', () => {
      const groups = [group({ id: 'g1', taskIds: ['a', 'b', 'c'], activeIndex: 2, labels: { c: 'Z' } })];
      const three = ejectTaskFromGroup(groups, 'g1', 'a');
      expect(three[0].taskIds).toEqual(['b', 'c']);
      expect(three[0].labels).toEqual({ c: 'Z' });

      const dissolved = ejectTaskFromGroup([group({ id: 'g1', taskIds: ['a', 'b'] })], 'g1', 'b');
      expect(dissolved).toEqual([]);
    });
  });

  it('seeds the id counter above every persisted id', () => {
    expect(maxTaskCardGroupIdCounter([
      group({ id: 'tabcard-3', taskIds: ['a', 'b'] }),
      group({ id: 'tabcard-7', taskIds: ['c', 'd'] }),
      group({ id: 'legacy', taskIds: ['e', 'f'] }),
    ])).toBe(7);
  });
});
