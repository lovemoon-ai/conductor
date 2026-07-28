import { describe, expect, it } from 'vitest';
import {
  addProjectToGroup,
  buildProjectCardRows,
  createProjectCardGroup,
  ejectProjectFromGroup,
  maxProjectCardGroupIdCounter,
  mergeSyncedProjectCardGroups,
  readProjectCardGroups,
  readProjectCardGroupsSyncSnapshot,
  readSyncedProjectCardGroups,
  setActiveProjectCardTab,
  setProjectCardTabLabel,
  type ProjectCardGroup,
} from './project-card-groups';

type FakeGroup = { key: string; members: { id: string }[] };

const fakeGroups = (...keys: string[]): FakeGroup[] =>
  keys.map((key) => ({ key, members: [{ id: key }] }));

const resolverFor = (groups: FakeGroup[]) => {
  const byMember = new Map<string, FakeGroup>();
  for (const group of groups) {
    for (const member of group.members) byMember.set(member.id, group);
  }
  return (projectId: string) => byMember.get(projectId) ?? null;
};

describe('readProjectCardGroups', () => {
  it('drops groups with fewer than two distinct projects', () => {
    expect(readProjectCardGroups([{ id: 'a', projectIds: ['p1'] }])).toEqual([]);
    expect(readProjectCardGroups([{ id: 'a', projectIds: ['p1', 'p1'] }])).toEqual([]);
  });

  it('enforces single-group membership per project across groups', () => {
    const groups = readProjectCardGroups([
      { id: 'a', projectIds: ['p1', 'p2'] },
      { id: 'b', projectIds: ['p2', 'p3'] },
    ]);
    // p2 is claimed by group a, so group b keeps only p3 → collapses.
    expect(groups).toEqual([
      { id: 'a', projectIds: ['p1', 'p2'], activeIndex: 0, labels: {} },
    ]);
  });

  it('clamps activeIndex and keeps only labels for present projects', () => {
    const groups = readProjectCardGroups([
      { id: 'a', projectIds: ['p1', 'p2'], activeIndex: 9, labels: { p1: 'One', pX: 'ghost', p2: '  ' } },
    ]);
    expect(groups[0].activeIndex).toBe(1);
    expect(groups[0].labels).toEqual({ p1: 'One' });
  });
});

describe('mutators', () => {
  it('creates a two-tab aggregation with the dragged tab active', () => {
    const next = createProjectCardGroup([], 'g1', 'target', 'dragged');
    expect(next).toEqual([
      { id: 'g1', projectIds: ['target', 'dragged'], activeIndex: 1, labels: {} },
    ]);
  });

  it('refuses to aggregate a card onto itself', () => {
    expect(createProjectCardGroup([], 'g1', 'p1', 'p1')).toEqual([]);
  });

  it('moves a project out of its old aggregation when re-aggregated', () => {
    const start = createProjectCardGroup([], 'g1', 'p1', 'p2');
    const next = createProjectCardGroup(start, 'g2', 'p3', 'p2');
    // g1 had [p1,p2]; removing p2 leaves p1 alone → g1 dissolves.
    expect(next).toEqual([
      { id: 'g2', projectIds: ['p3', 'p2'], activeIndex: 1, labels: {} },
    ]);
  });

  it('appends a project as the new active tab of an existing aggregation', () => {
    const start = createProjectCardGroup([], 'g1', 'p1', 'p2');
    const next = addProjectToGroup(start, 'g1', 'p3');
    expect(next[0].projectIds).toEqual(['p1', 'p2', 'p3']);
    expect(next[0].activeIndex).toBe(2);
  });

  it('switches and clamps the active tab', () => {
    const start: ProjectCardGroup[] = [
      { id: 'g1', projectIds: ['p1', 'p2', 'p3'], activeIndex: 0, labels: {} },
    ];
    expect(setActiveProjectCardTab(start, 'g1', 'p3')[0].activeIndex).toBe(2);
    expect(setActiveProjectCardTab(start, 'g1', 'missing')[0].activeIndex).toBe(0);
  });

  it('sets and clears a tab label', () => {
    const start = createProjectCardGroup([], 'g1', 'p1', 'p2');
    const labelled = setProjectCardTabLabel(start, 'g1', 'p1', 'Frontend');
    expect(labelled[0].labels).toEqual({ p1: 'Frontend' });
    const cleared = setProjectCardTabLabel(labelled, 'g1', 'p1', '   ');
    expect(cleared[0].labels).toEqual({});
  });

  it('dissolves an aggregation when ejecting leaves a single tab', () => {
    const start = createProjectCardGroup([], 'g1', 'p1', 'p2');
    expect(ejectProjectFromGroup(start, 'g1', 'p2')).toEqual([]);
  });

  it('keeps the aggregation and repoints active when ejecting from 3+ tabs', () => {
    const start: ProjectCardGroup[] = [
      { id: 'g1', projectIds: ['p1', 'p2', 'p3'], activeIndex: 1, labels: { p2: 'x' } },
    ];
    const next = ejectProjectFromGroup(start, 'g1', 'p2');
    expect(next[0].projectIds).toEqual(['p1', 'p3']);
    expect(next[0].activeIndex).toBe(0);
    expect(next[0].labels).toEqual({});
  });
});

describe('buildProjectCardRows', () => {
  it('folds aggregated cards into a single tab row anchored at the first member', () => {
    const groups = fakeGroups('p1', 'p2', 'p3');
    const aggregations: ProjectCardGroup[] = [
      { id: 'g1', projectIds: ['p1', 'p3'], activeIndex: 1, labels: {} },
    ];
    const rows = buildProjectCardRows(groups, aggregations, resolverFor(groups));
    expect(rows.map((row) => (row.type === 'group' ? row.group.key : `agg:${row.id}`)))
      .toEqual(['agg:g1', 'p2']);
    const aggRow = rows[0];
    if (aggRow.type !== 'aggregation') throw new Error('expected aggregation row');
    expect(aggRow.tabs.map((tab) => tab.projectId)).toEqual(['p1', 'p3']);
    expect(aggRow.activeProjectId).toBe('p3');
  });

  it('dissolves an aggregation whose members are no longer visible', () => {
    const groups = fakeGroups('p1'); // p3 filtered out
    const aggregations: ProjectCardGroup[] = [
      { id: 'g1', projectIds: ['p1', 'p3'], activeIndex: 0, labels: {} },
    ];
    const rows = buildProjectCardRows(groups, aggregations, resolverFor(groups));
    expect(rows).toEqual([{ type: 'group', group: groups[0] }]);
  });

  it('de-duplicates tabs that resolve to the same card', () => {
    // p1 and p1b both belong to one merged group keyed "m".
    const merged: FakeGroup = { key: 'm', members: [{ id: 'p1' }, { id: 'p1b' }] };
    const other: FakeGroup = { key: 'p2', members: [{ id: 'p2' }] };
    const groups = [merged, other];
    const aggregations: ProjectCardGroup[] = [
      { id: 'g1', projectIds: ['p1', 'p1b'], activeIndex: 0, labels: {} },
    ];
    // Both ids resolve to card "m" → only one distinct tab → not an aggregation.
    const rows = buildProjectCardRows(groups, aggregations, resolverFor(groups));
    expect(rows.every((row) => row.type === 'group')).toBe(true);
  });
});

describe('snapshot + sync helpers', () => {
  it('reads a bounded snapshot and ignores non-projects scopes', () => {
    const snapshot = readProjectCardGroupsSyncSnapshot({
      version: 1,
      revision: 4,
      scopes: {
        'projects:all': [{ id: 'g1', projectIds: ['p1', 'p2'], labels: {} }],
        'other:scope': [{ id: 'g2', projectIds: ['p3', 'p4'], labels: {} }],
      },
    });
    expect(snapshot.revision).toBe(4);
    expect(Object.keys(snapshot.scopes)).toEqual(['projects:all']);
  });

  it('strips activeIndex from the synced shape', () => {
    const synced = readSyncedProjectCardGroups([
      { id: 'g1', projectIds: ['p1', 'p2'], activeIndex: 1, labels: { p1: 'A' } },
    ]);
    expect(synced).toEqual([{ id: 'g1', projectIds: ['p1', 'p2'], labels: { p1: 'A' } }]);
  });

  it('preserves the local active tab when merging server structure', () => {
    const local: ProjectCardGroup[] = [
      { id: 'g1', projectIds: ['p1', 'p2', 'p3'], activeIndex: 2, labels: {} },
    ];
    const merged = mergeSyncedProjectCardGroups(local, [
      { id: 'g1', projectIds: ['p1', 'p3', 'p2'], labels: {} },
    ]);
    // Active project p3 is now at index 1 in the server order.
    expect(merged[0].activeIndex).toBe(1);
  });

  it('reports the highest aggregation id counter', () => {
    expect(maxProjectCardGroupIdCounter([
      { id: 'projcard-2', projectIds: ['p1', 'p2'], activeIndex: 0, labels: {} },
      { id: 'projcard-7', projectIds: ['p3', 'p4'], activeIndex: 0, labels: {} },
    ])).toBe(7);
  });
});
