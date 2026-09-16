import { describe, expect, it } from 'vitest';
import type { TaskLabel } from '@/lib/projects/task-labels';
import {
  buildMetadataWithTaskLabelIds,
  MAX_TASK_LABEL_IDS,
  normalizeTaskLabelIds,
  readTaskLabelIds,
  resolveTaskLabels,
  TASK_LABEL_IDS_METADATA_KEY,
  toggleTaskLabelId,
} from './task-labels';

const labels: TaskLabel[] = [
  { id: 'l1', name: 'bug' },
  { id: 'l2', name: 'chore' },
  { id: 'l3', name: 'urgent' },
];

describe('normalizeTaskLabelIds', () => {
  it('drops non-strings, blanks and duplicates while preserving order', () => {
    expect(normalizeTaskLabelIds(['b', 'a', 'b', '', '  ', 7, null, 'a'])).toEqual(['b', 'a']);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeTaskLabelIds([' l1 '])).toEqual(['l1']);
  });

  it('returns [] for non-array input', () => {
    expect(normalizeTaskLabelIds(undefined)).toEqual([]);
    expect(normalizeTaskLabelIds('l1')).toEqual([]);
  });

  it('caps the list length', () => {
    const ids = Array.from({ length: MAX_TASK_LABEL_IDS + 10 }, (_, i) => `l${i}`);
    expect(normalizeTaskLabelIds(ids)).toHaveLength(MAX_TASK_LABEL_IDS);
  });
});

describe('readTaskLabelIds', () => {
  it('reads the stored list', () => {
    expect(readTaskLabelIds({ metadata: { labelIds: ['l1', 'l2'] } })).toEqual(['l1', 'l2']);
  });

  it('returns [] when absent or malformed', () => {
    expect(readTaskLabelIds({ metadata: null })).toEqual([]);
    expect(readTaskLabelIds({ metadata: { labelIds: 'l1' } })).toEqual([]);
    expect(readTaskLabelIds(null)).toEqual([]);
  });
});

describe('buildMetadataWithTaskLabelIds', () => {
  it('preserves daemon-owned metadata keys', () => {
    const next = buildMetadataWithTaskLabelIds(
      { daemonName: 'mac-mini', backendType: 'claude' },
      ['l1'],
    );
    expect(next).toEqual({ daemonName: 'mac-mini', backendType: 'claude', labelIds: ['l1'] });
  });

  it('removes the key entirely when the list is empty', () => {
    const next = buildMetadataWithTaskLabelIds({ labelIds: ['l1'], daemonName: 'x' }, []);
    expect(TASK_LABEL_IDS_METADATA_KEY in next).toBe(false);
    expect(next.daemonName).toBe('x');
  });

  it('normalizes what it stores', () => {
    const next = buildMetadataWithTaskLabelIds(null, ['l1', 'l1', ' l2 ']);
    expect(next.labelIds).toEqual(['l1', 'l2']);
  });

  it('does not mutate the source metadata', () => {
    const metadata = { labelIds: ['l1'] };
    buildMetadataWithTaskLabelIds(metadata, ['l2']);
    expect(metadata.labelIds).toEqual(['l1']);
  });
});

describe('resolveTaskLabels', () => {
  it('returns the project definitions for the assigned ids', () => {
    expect(resolveTaskLabels(['l2'], labels)).toEqual([labels[1]]);
  });

  it('orders by the project definition, not by assignment order', () => {
    // Every card must list labels in the same order the settings dialog does.
    expect(resolveTaskLabels(['l3', 'l1'], labels).map((l) => l.id)).toEqual(['l1', 'l3']);
  });

  it('ignores ids with no matching definition instead of rendering a blank chip', () => {
    expect(resolveTaskLabels(['l1', 'deleted-label'], labels)).toEqual([labels[0]]);
  });

  it('returns [] for the empty cases', () => {
    expect(resolveTaskLabels([], labels)).toEqual([]);
    expect(resolveTaskLabels(['l1'], [])).toEqual([]);
  });
});

describe('toggleTaskLabelId', () => {
  it('adds an unselected label and removes a selected one', () => {
    expect(toggleTaskLabelId([], 'l2', labels)).toEqual(['l2']);
    expect(toggleTaskLabelId(['l1', 'l2'], 'l1', labels)).toEqual(['l2']);
  });

  it('orders known ids by definition, not by click order', () => {
    expect(toggleTaskLabelId(['l3'], 'l1', labels)).toEqual(['l1', 'l3']);
  });

  it('keeps ids this view does not define', () => {
    // Regression: the picker rebuilt the list from the visible definitions only,
    // so toggling any label erased ids from the task's other project (it was
    // filed elsewhere) or from a since-deleted label.
    expect(toggleTaskLabelId(['other-project-label', 'l1'], 'l2', labels)).toEqual([
      'l1',
      'l2',
      'other-project-label',
    ]);
    expect(toggleTaskLabelId(['deleted', 'l1'], 'l1', labels)).toEqual(['deleted']);
  });
});

