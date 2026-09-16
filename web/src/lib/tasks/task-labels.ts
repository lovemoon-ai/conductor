/**
 * Task side of the task-label feature — which labels a given task carries.
 *
 * Only label *ids* are stored, under `task.metadata.labelIds`. The names and
 * colours live once per project (`lib/projects/task-labels.ts`), so renaming or
 * recolouring a label updates every task that carries it without touching a
 * single task row.
 *
 * Ids that no longer resolve to a project label (the label was deleted, or the
 * task was filed under a different project) are simply not rendered — see
 * `resolveTaskLabels`. We deliberately do NOT prune them on read: a task
 * temporarily displayed under another project must not silently lose its
 * labels, and deleting a label is already a fan-out write that cleans up.
 */
import type { TaskLabel } from '@/lib/projects/task-labels';

export const TASK_LABEL_IDS_METADATA_KEY = 'labelIds';

/**
 * Cap per task. Generous relative to `MAX_TASK_LABELS_PER_PROJECT` — the limit
 * exists to bound the metadata blob, not to shape how people tag.
 */
export const MAX_TASK_LABEL_IDS = 50;

const readMetadataRecord = (
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> =>
  metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : {};

/**
 * Normalize an arbitrary value into a deduped list of label ids.
 *
 * Shared by the read path and the API's request validation so a hand-written
 * request body and a stored blob are subject to exactly the same rules.
 */
export const normalizeTaskLabelIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_TASK_LABEL_IDS) break;
  }
  return ids;
};

export const readTaskLabelIdsFromMetadata = (
  metadata: Record<string, unknown> | null | undefined,
): string[] =>
  normalizeTaskLabelIds(readMetadataRecord(metadata)[TASK_LABEL_IDS_METADATA_KEY]);

/** Convenience wrapper for the client-side `Task` shape. */
export const readTaskLabelIds = (
  task: { metadata?: Record<string, unknown> | null } | null | undefined,
): string[] => readTaskLabelIdsFromMetadata(task?.metadata);

/**
 * Merge label ids back into existing task metadata, preserving daemon-owned
 * keys (`agentRole`, `daemonName`, `backendType`, …).
 *
 * An empty list removes the key entirely rather than storing `[]`, so a task
 * that has never been labelled and one that was un-labelled look identical.
 */
export const buildMetadataWithTaskLabelIds = (
  metadata: Record<string, unknown> | null | undefined,
  labelIds: readonly string[],
): Record<string, unknown> => {
  const next = { ...readMetadataRecord(metadata) };
  const normalized = normalizeTaskLabelIds(labelIds as unknown);
  if (normalized.length === 0) {
    delete next[TASK_LABEL_IDS_METADATA_KEY];
  } else {
    next[TASK_LABEL_IDS_METADATA_KEY] = normalized;
  }
  return next;
};

/**
 * Resolve a task's label ids against the project's label definitions,
 * preserving the *project's* ordering so every card lists labels in the same
 * order the settings dialog shows them.
 */
export const resolveTaskLabels = (
  labelIds: readonly string[],
  projectLabels: readonly TaskLabel[],
): TaskLabel[] => {
  if (labelIds.length === 0 || projectLabels.length === 0) return [];
  const assigned = new Set(labelIds);
  return projectLabels.filter((label) => assigned.has(label.id));
};

/**
 * Next label-id set after toggling one label in a picker.
 *
 * Ids this view does not define are KEPT, not dropped. A picker only knows the
 * labels of the project a task is currently *displayed* under; the task may
 * also carry ids from its real project (it was filed elsewhere) or from a label
 * since deleted. Rebuilding the list from the visible definitions alone would
 * silently erase those on every click.
 *
 * Known ids come first in definition order so the stored list is stable
 * regardless of click order; unknown ids follow in their existing order.
 */
export const toggleTaskLabelId = (
  selectedIds: readonly string[],
  labelId: string,
  viewLabels: readonly TaskLabel[],
): string[] => {
  const selected = new Set(selectedIds);
  if (selected.has(labelId)) {
    selected.delete(labelId);
  } else {
    selected.add(labelId);
  }
  const known = new Set(viewLabels.map((label) => label.id));
  return [
    ...viewLabels.filter((label) => selected.has(label.id)).map((label) => label.id),
    ...selectedIds.filter((id) => !known.has(id) && selected.has(id)),
  ];
};
