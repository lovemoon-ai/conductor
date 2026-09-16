'use client';

import { useMemo, useState } from 'react';
import { useConfirm, useToast } from '@/components/common/FeedbackProvider';
import type { Project } from '@/shared/types';
import {
  buildMetadataWithTaskLabels,
  generateTaskLabelId,
  MAX_TASK_LABEL_NAME_CHARS,
  MAX_TASK_LABELS_PER_PROJECT,
  normalizeTaskLabelName,
  readMergedTaskLabels,
  TASK_LABEL_CHIP_CLASSNAME,
  taskLabelNameKey,
  type TaskLabel,
} from '@/lib/projects/task-labels';
import { useProjectsStore } from '../store';
import { expandMergedProjectGroup } from '../utils/project-groups';

interface ProjectTaskLabelsSectionProps {
  /**
   * Every member of the merged project group. Labels are read as the union over
   * members and written to all of them, so a label configured on one daemon
   * shows up on its merged siblings.
   */
  members: Project[];
}

export function ProjectTaskLabelsSection({ members }: ProjectTaskLabelsSectionProps) {
  const updateProjectGroupMetadata = useProjectsStore(
    (state) => state.updateProjectGroupMetadata,
  );
  const allProjects = useProjectsStore((state) => state.projects);
  const { pushToast } = useToast();
  const { confirm } = useConfirm();

  const [draftName, setDraftName] = useState('');
  const [isMutating, setIsMutating] = useState(false);
  // Optimistic overlay. The store is the source of truth, but a fan-out write
  // is several round-trips; without this the list would not move until the last
  // daemon replied.
  const [pendingLabels, setPendingLabels] = useState<TaskLabel[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  // Read the SAME member set the store's fan-out writes to — including hidden
  // members the project list leaves out of `members`. Otherwise this list and
  // the task cards could disagree about which labels exist.
  const groupProjects = useMemo(
    () => expandMergedProjectGroup(members, allProjects),
    [members, allProjects],
  );
  const storedLabels = useMemo(() => readMergedTaskLabels(groupProjects), [groupProjects]);
  const labels = pendingLabels ?? storedLabels;
  const memberIds = useMemo(() => members.map((member) => member.id), [members]);
  const isMerged = groupProjects.length > 1;

  const commit = async (next: TaskLabel[], failureTitle: string) => {
    setPendingLabels(next);
    setIsMutating(true);
    try {
      await updateProjectGroupMetadata(memberIds, (project) =>
        buildMetadataWithTaskLabels(project, next),
      );
      setPendingLabels(null);
    } catch (error) {
      // Drop the overlay so the list falls back to whatever actually persisted
      // rather than showing an edit that only exists on this screen.
      setPendingLabels(null);
      pushToast({
        title: failureTitle,
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'error',
      });
    } finally {
      setIsMutating(false);
    }
  };

  const handleAdd = async () => {
    const name = normalizeTaskLabelName(draftName);
    if (!name || isMutating) return;
    if (labels.length >= MAX_TASK_LABELS_PER_PROJECT) {
      pushToast({
        title: 'Label limit reached',
        description: `A project can have at most ${MAX_TASK_LABELS_PER_PROJECT} labels.`,
        variant: 'error',
      });
      return;
    }
    if (labels.some((label) => taskLabelNameKey(label.name) === taskLabelNameKey(name))) {
      pushToast({
        title: 'Label already exists',
        description: `"${name}" is already defined for this project.`,
        variant: 'error',
      });
      return;
    }
    setDraftName('');
    await commit(
      [...labels, { id: generateTaskLabelId(), name }],
      'Failed to add label',
    );
  };

  const handleRename = async (labelId: string) => {
    const name = normalizeTaskLabelName(editingName);
    const current = labels.find((label) => label.id === labelId);
    setEditingId(null);
    setEditingName('');
    if (!current || !name || name === current.name) return;
    if (
      labels.some(
        (label) =>
          label.id !== labelId
          && taskLabelNameKey(label.name) === taskLabelNameKey(name),
      )
    ) {
      pushToast({
        title: 'Label already exists',
        description: `"${name}" is already defined for this project.`,
        variant: 'error',
      });
      return;
    }
    await commit(
      labels.map((label) => (label.id === labelId ? { ...label, name } : label)),
      'Failed to rename label',
    );
  };

  const handleDelete = async (label: TaskLabel) => {
    if (isMutating) return;
    const accepted = await confirm({
      title: `Delete label "${label.name}"?`,
      description:
        'Tasks currently carrying this label will stop showing it. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!accepted) return;
    await commit(
      labels.filter((candidate) => candidate.id !== label.id),
      'Failed to delete label',
    );
  };

  return (
    <section>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Task labels
        </h3>
        <span className="text-xs text-muted">
          {labels.length}/{MAX_TASK_LABELS_PER_PROJECT}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">
        {isMerged
          ? `Attach these to tasks from the task card. Shared across all ${groupProjects.length} daemons in this merged project.`
          : 'Attach these to tasks from the task card.'}
      </p>

      <div className="mt-3 space-y-2">
        {labels.length === 0 ? (
          <p className="text-sm text-muted">
            No labels yet. Add one below to start tagging tasks.
          </p>
        ) : null}
        {labels.map((label) => (
          <div
            key={label.id}
            className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5"
          >
            {editingId === label.id ? (
              <input
                type="text"
                aria-label={`Rename label ${label.name}`}
                value={editingName}
                maxLength={MAX_TASK_LABEL_NAME_CHARS}
                autoFocus
                onChange={(event) => setEditingName(event.target.value)}
                onBlur={() => void handleRename(label.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleRename(label.id);
                  if (event.key === 'Escape') {
                    setEditingId(null);
                    setEditingName('');
                  }
                }}
                className="min-w-0 flex-1 rounded bg-transparent px-1 text-sm text-ink outline-none ring-1 ring-[var(--accent)]"
              />
            ) : (
              <button
                type="button"
                title="Click to rename"
                onClick={() => {
                  setEditingId(label.id);
                  setEditingName(label.name);
                }}
                className={`max-w-[16rem] truncate ${TASK_LABEL_CHIP_CLASSNAME}`}
              >
                {label.name}
              </button>
            )}
            <button
              type="button"
              aria-label={`Delete label ${label.name}`}
              disabled={isMutating}
              onClick={() => void handleDelete(label)}
              className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-xs text-muted transition-colors hover:text-red-500 disabled:opacity-50"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          type="text"
          aria-label="New label name"
          placeholder="New label"
          value={draftName}
          maxLength={MAX_TASK_LABEL_NAME_CHARS}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void handleAdd();
          }}
          className="min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2 py-1.5 text-sm text-ink outline-none focus:border-[var(--accent)]"
        />
        <button
          type="button"
          disabled={!normalizeTaskLabelName(draftName) || isMutating}
          onClick={() => void handleAdd()}
          className="shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-ink transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </section>
  );
}
