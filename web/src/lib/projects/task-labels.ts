/**
 * Task labels — user-defined, per-project tags that can be attached to tasks.
 *
 * Distinct from `Issue.type` (`lib/issues/config.ts`), which is a fixed
 * three-way enum living on an Issue. Task labels are free-form, defined by the
 * user per project, and a task may carry several at once.
 *
 * Storage follows the established project-settings pattern (`taskGraphEnabled`,
 * `memos`): the definitions live in the `project.metadata` JSON blob under
 * `taskLabels`, so no dedicated table or migration is needed. The task side
 * stores only label ids — see `lib/tasks/task-labels.ts`.
 *
 * ## Cross-daemon merged groups
 *
 * The same repo checked out on two machines is two `Project` rows (one per
 * daemon) that the UI displays as a single merged card — see
 * `lib/projects/grouping.ts`. Label definitions are a property of *the project*,
 * not of the machine it happens to be checked out on, so they are shared across
 * the whole merged group:
 *
 *   - reads union every member's list (`readMergedTaskLabels`), so a member that
 *     has never been written to still shows the group's labels, and a daemon
 *     that joins later needs no backfill;
 *   - writes fan out to every member (see `updateProjectGroupMetadata` in the
 *     projects store), so each row converges on the same list.
 *
 * Both halves must cover the SAME member set — including hidden (archived)
 * members. If a write skipped a member that reads still union, a deleted label
 * would resurrect from it.
 */
import type { Project } from '@/shared/types';

export const TASK_LABELS_METADATA_KEY = 'taskLabels';

/**
 * Shared chip styling. Labels are intentionally uncoloured: an outlined chip
 * reads as a tag while staying visually distinct from the filled metadata chips
 * already on a task card (task type, backend, project, daemon).
 */
export const TASK_LABEL_CHIP_CLASSNAME =
  'rounded border border-border px-1.5 py-0.5 text-xs font-medium text-ink';

/** Keeps chips scannable on a task card and the metadata blob bounded. */
export const MAX_TASK_LABEL_NAME_CHARS = 32;
/** Total cap per project — protects the 256 KiB project metadata budget. */
export const MAX_TASK_LABELS_PER_PROJECT = 50;

export interface TaskLabel {
  id: string;
  name: string;
}

/**
 * Collapse internal whitespace and trim, then clamp to the length cap. Returns
 * '' for anything unusable so callers have a single falsy check for "reject".
 */
export const normalizeTaskLabelName = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_TASK_LABEL_NAME_CHARS);
};

/** Case-insensitive identity used to detect duplicate label names. */
export const taskLabelNameKey = (name: string): string =>
  normalizeTaskLabelName(name).toLowerCase();

/**
 * Parse one entry from the metadata blob. Unnamed entries are dropped rather
 * than rendering a blank chip. Unknown fields (e.g. a `color` written by an
 * earlier build) are ignored, not preserved.
 */
const parseTaskLabel = (value: unknown): TaskLabel | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id) return null;
  const name = normalizeTaskLabelName(record.name);
  if (!name) return null;
  return { id: record.id, name };
};

const readMetadataRecord = (
  project: Project | null | undefined,
): Record<string, unknown> =>
  project?.metadata && typeof project.metadata === 'object' && !Array.isArray(project.metadata)
    ? (project.metadata as Record<string, unknown>)
    : {};

/**
 * Core reader, over an already-parsed metadata object.
 *
 * API routes hold `project.metadata` as the raw JSON *string* straight from
 * Prisma, while the client holds it parsed; both go through here so server
 * validation and client rendering can never disagree on what a stored blob
 * means.
 */
export const readTaskLabelsFromMetadata = (
  metadata: Record<string, unknown> | null | undefined,
): TaskLabel[] => {
  const raw =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata[TASK_LABELS_METADATA_KEY]
      : undefined;
  if (!Array.isArray(raw)) return [];
  const labels: TaskLabel[] = [];
  const seenIds = new Set<string>();
  for (const entry of raw) {
    const label = parseTaskLabel(entry);
    // Guard against a hand-edited blob carrying the same id twice — later
    // lookups are by id, so duplicates would render the chip twice.
    if (!label || seenIds.has(label.id)) continue;
    seenIds.add(label.id);
    labels.push(label);
  }
  return labels;
};

/** Label definitions stored on a single project row. */
export const readProjectTaskLabels = (
  project: Project | null | undefined,
): TaskLabel[] => readTaskLabelsFromMetadata(readMetadataRecord(project));

/**
 * The label set for a merged project group: the union over all members.
 *
 * Deduped by **id only**. Tasks store label ids, so identity must be the id:
 * deduping by name as well would silently drop the definition a task actually
 * points at whenever two daemons independently created a same-named label
 * before they merged — that task's chip would vanish, and an id lookup would
 * miss. Such duplicates are rare, shown honestly, and resolvable by deleting
 * one in settings; new duplicates are refused at creation time.
 */
export const readMergedTaskLabels = (
  projects: readonly (Project | null | undefined)[],
): TaskLabel[] => {
  const labels: TaskLabel[] = [];
  const seenIds = new Set<string>();
  for (const project of projects) {
    for (const label of readProjectTaskLabels(project)) {
      if (seenIds.has(label.id)) continue;
      seenIds.add(label.id);
      labels.push(label);
    }
  }
  return labels;
};

/**
 * Merge a label list back into the project's existing metadata so sibling keys
 * (`memos`, `taskGraphEnabled`, `bindingCandidate`, …) survive the PATCH.
 */
export const buildMetadataWithTaskLabels = (
  project: Project,
  labels: readonly TaskLabel[],
): Record<string, unknown> => {
  const metadata = { ...readMetadataRecord(project) };
  metadata[TASK_LABELS_METADATA_KEY] = labels.map((label) => ({
    id: label.id,
    name: label.name,
  }));
  return metadata;
};

export const generateTaskLabelId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `label-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};
