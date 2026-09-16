import { describe, expect, it } from 'vitest';
import type { Project } from '@/shared/types';
import {
  buildMetadataWithTaskLabels,
  MAX_TASK_LABEL_NAME_CHARS,
  normalizeTaskLabelName,
  readMergedTaskLabels,
  readProjectTaskLabels,
  taskLabelNameKey,
  type TaskLabel,
} from './task-labels';

const project = (metadata: Record<string, unknown> | null, id = 'p1'): Project => ({
  id,
  name: 'conductor',
  metadata,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const label = (overrides: Partial<TaskLabel> = {}): TaskLabel => ({
  id: 'l1',
  name: 'bug',
  ...overrides,
});

describe('normalizeTaskLabelName', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeTaskLabelName('  needs   review  ')).toBe('needs review');
  });

  it('clamps to the length cap', () => {
    const name = normalizeTaskLabelName('x'.repeat(MAX_TASK_LABEL_NAME_CHARS + 20));
    expect(name).toHaveLength(MAX_TASK_LABEL_NAME_CHARS);
  });

  it('returns empty string for unusable input', () => {
    expect(normalizeTaskLabelName('   ')).toBe('');
    expect(normalizeTaskLabelName(null)).toBe('');
    expect(normalizeTaskLabelName(42)).toBe('');
  });
});

describe('readProjectTaskLabels', () => {
  it('reads well-formed labels', () => {
    expect(
      readProjectTaskLabels(project({ taskLabels: [label()] })),
    ).toEqual([label()]);
  });

  it('returns [] when the key is missing or not an array', () => {
    expect(readProjectTaskLabels(project(null))).toEqual([]);
    expect(readProjectTaskLabels(project({}))).toEqual([]);
    expect(readProjectTaskLabels(project({ taskLabels: 'nope' }))).toEqual([]);
  });

  it('drops entries with no usable name and keeps the rest', () => {
    const labels = readProjectTaskLabels(
      project({
        taskLabels: [
          { id: 'a', name: '   ' },
          { id: 'b', name: 'ok' },
          { name: 'no id' },
        ],
      }),
    );
    expect(labels).toEqual([{ id: 'b', name: 'ok' }]);
  });

  it('ignores a legacy color field left by an earlier build', () => {
    // Labels used to carry a colour; a stored blob may still have one. It is
    // dropped on read rather than preserved, so nothing downstream sees it.
    const [parsed] = readProjectTaskLabels(
      project({ taskLabels: [{ id: 'a', name: 'x', color: 'chartreuse' }] }),
    );
    expect(parsed).toEqual({ id: 'a', name: 'x' });
  });

  it('drops a duplicated id so a chip cannot render twice', () => {
    const labels = readProjectTaskLabels(
      project({
        taskLabels: [
          { id: 'a', name: 'first' },
          { id: 'a', name: 'second' },
        ],
      }),
    );
    expect(labels).toEqual([{ id: 'a', name: 'first' }]);
  });
});

describe('readMergedTaskLabels', () => {
  it('unions labels across every member of a merged group', () => {
    const a = project({ taskLabels: [label({ id: 'l1', name: 'bug' })] }, 'a');
    const b = project({ taskLabels: [label({ id: 'l2', name: 'chore' })] }, 'b');
    expect(readMergedTaskLabels([a, b]).map((l) => l.name)).toEqual(['bug', 'chore']);
  });

  it('dedupes by id when both members already carry the same label', () => {
    const shared = label({ id: 'l1', name: 'bug' });
    const a = project({ taskLabels: [shared] }, 'a');
    const b = project({ taskLabels: [shared] }, 'b');
    expect(readMergedTaskLabels([a, b])).toEqual([shared]);
  });

  it('keeps same-named labels with different ids instead of deduping by name', () => {
    // Regression: two daemons independently grew a "bug" label before they
    // merged. Deduping by name dropped l2, so every task tagged l2 lost its
    // chip and any lookup of l2 by id missed. Identity is the id.
    const a = project({ taskLabels: [label({ id: 'l1', name: 'Bug' })] }, 'a');
    const b = project({ taskLabels: [label({ id: 'l2', name: 'bug' })] }, 'b');
    expect(readMergedTaskLabels([a, b])).toEqual([
      { id: 'l1', name: 'Bug' },
      { id: 'l2', name: 'bug' },
    ]);
  });

  it('surfaces a label from a sibling that the first member has never seen', () => {
    // The union-on-read half of the sync contract: a daemon that joined the
    // group later has no labels of its own but must still show the group's.
    const fresh = project(null, 'fresh');
    const configured = project({ taskLabels: [label()] }, 'configured');
    expect(readMergedTaskLabels([fresh, configured])).toEqual([label()]);
  });
});

describe('buildMetadataWithTaskLabels', () => {
  it('preserves sibling metadata keys', () => {
    const next = buildMetadataWithTaskLabels(
      project({ memos: [{ id: 'm1' }], taskGraphEnabled: true }),
      [label()],
    );
    expect(next.memos).toEqual([{ id: 'm1' }]);
    expect(next.taskGraphEnabled).toBe(true);
    expect(next.taskLabels).toEqual([label()]);
  });

  it('writes a plain serializable shape, dropping unknown fields', () => {
    const next = buildMetadataWithTaskLabels(project(null), [
      { ...label(), extra: 'nope' } as TaskLabel,
    ]);
    expect(next.taskLabels).toEqual([{ id: 'l1', name: 'bug' }]);
  });

  it('can clear every label', () => {
    const next = buildMetadataWithTaskLabels(project({ taskLabels: [label()] }), []);
    expect(next.taskLabels).toEqual([]);
  });

  it('does not mutate the source metadata', () => {
    const metadata = { taskLabels: [label()] };
    buildMetadataWithTaskLabels(project(metadata), []);
    expect(metadata.taskLabels).toEqual([label()]);
  });
});

describe('taskLabelNameKey', () => {
  it('matches names that differ only by case or spacing', () => {
    expect(taskLabelNameKey('  Needs   Review ')).toBe(taskLabelNameKey('needs review'));
  });
});
