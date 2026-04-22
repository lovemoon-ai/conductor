'use client';

import { useEffect, useState } from 'react';
import type { Issue } from '@/shared/types';
import { Dialog } from '@/components/common/Dialog';
import { InlineNotice } from '@/components/common/InlineNotice';
import { useToast } from '@/components/common/FeedbackProvider';
import { DEFAULT_ISSUE_PRIORITY, ISSUE_PRIORITIES, ISSUE_PRIORITY_LABELS } from '@/lib/issues/config';
import { useIssuesStore } from '../store';

export function EditIssueDialog({
  open,
  onClose,
  issue,
}: {
  open: boolean;
  onClose: () => void;
  issue: Issue | null;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Issue['priority']>(DEFAULT_ISSUE_PRIORITY);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const updateIssue = useIssuesStore((state) => state.updateIssue);
  const { pushToast } = useToast();

  useEffect(() => {
    if (!open || !issue) {
      return;
    }
    setTitle(issue.title);
    setDescription(issue.description ?? '');
    setPriority(issue.priority);
    setLocalError(null);
  }, [issue, open]);

  const handleClose = () => {
    if (isSubmitting) {
      return;
    }
    onClose();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!issue) {
      return;
    }
    const nextTitle = title.trim();
    if (!nextTitle) {
      setLocalError('Title is required.');
      return;
    }

    const nextDescription = description.trim();
    const previousDescription = issue.description?.trim() ?? '';
    const titleChanged = nextTitle !== issue.title;
    const descriptionChanged = nextDescription !== previousDescription;
    const priorityChanged = priority !== issue.priority;

    if (!titleChanged && !descriptionChanged && !priorityChanged) {
      onClose();
      return;
    }

    setIsSubmitting(true);
    setLocalError(null);
    try {
      await updateIssue(issue.id, {
        ...(titleChanged ? { title: nextTitle } : {}),
        ...(descriptionChanged ? { description: nextDescription ? nextDescription : null } : {}),
        ...(priorityChanged ? { priority } : {}),
      });
      pushToast({
        title: 'Issue updated',
        variant: 'success',
      });
      onClose();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Failed to update issue.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Edit Issue"
      maxWidthClassName="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="mb-2 block text-sm font-medium text-ink">Title</label>
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Summarize the issue"
            className="w-full webapp-input"
            autoFocus
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-ink">Description</label>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Add context, acceptance criteria, or raw requirement notes"
            className="min-h-32 w-full resize-y webapp-input"
          />
        </div>

        <div>
          <label htmlFor="edit-issue-priority" className="mb-2 block text-sm font-medium text-ink">Priority</label>
          <select
            id="edit-issue-priority"
            value={priority}
            onChange={(event) => setPriority(event.target.value as Issue['priority'])}
            className="w-full webapp-input"
          >
            {ISSUE_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {ISSUE_PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        {localError ? (
          <InlineNotice variant="error" title="Update failed">
            {localError}
          </InlineNotice>
        ) : null}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg px-4 py-2.5 text-sm text-muted transition-colors hover:bg-border/30 hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!issue || !title.trim() || isSubmitting}
            className="webapp-btn-primary px-5 py-2.5 text-sm"
          >
            {isSubmitting ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
