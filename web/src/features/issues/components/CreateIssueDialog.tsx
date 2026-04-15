'use client';

import { useEffect, useState } from 'react';
import type { IssueStatus } from '@/shared/types';
import { Dialog } from '@/components/common/Dialog';
import { InlineNotice } from '@/components/common/InlineNotice';
import { useToast } from '@/components/common/FeedbackProvider';
import { ISSUE_STATUSES, ISSUE_STATUS_LABELS } from '@/lib/issues/config';
import { useIssuesStore } from '../store';

export function CreateIssueDialog({
  open,
  onClose,
  projectId,
  defaultStatus = 'backlog',
}: {
  open: boolean;
  onClose: () => void;
  projectId: string | null;
  defaultStatus?: IssueStatus;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<IssueStatus>(defaultStatus);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const createIssue = useIssuesStore((state) => state.createIssue);
  const error = useIssuesStore((state) => state.error);
  const clearError = useIssuesStore((state) => state.clearError);
  const { pushToast } = useToast();

  useEffect(() => {
    if (!open) {
      return;
    }
    setTitle('');
    setDescription('');
    setStatus(defaultStatus);
    clearError();
  }, [clearError, defaultStatus, open]);

  const handleClose = () => {
    if (isSubmitting) {
      return;
    }
    onClose();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectId || !title.trim()) {
      return;
    }

    setIsSubmitting(true);
    try {
      await createIssue({
        projectId,
        title: title.trim(),
        description: description.trim() ? description.trim() : null,
        status,
      });
      pushToast({
        title: 'Issue created',
        description: `Added to ${ISSUE_STATUS_LABELS[status]}.`,
        variant: 'success',
      });
      onClose();
    } catch {
      // Store captures the message; surfaced below.
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Create Issue"
      description="Capture a requirement or problem for the current project."
      maxWidthClassName="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {!projectId ? (
          <InlineNotice variant="warning" title="No project available">
            Select a project before creating an issue.
          </InlineNotice>
        ) : null}

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
          <label className="mb-2 block text-sm font-medium text-ink">Initial status</label>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as IssueStatus)}
            className="w-full webapp-input"
          >
            {ISSUE_STATUSES.map((issueStatus) => (
              <option key={issueStatus} value={issueStatus}>
                {ISSUE_STATUS_LABELS[issueStatus]}
              </option>
            ))}
          </select>
        </div>

        {error ? (
          <InlineNotice variant="error" title="Issue creation failed">
            {error}
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
            disabled={!projectId || !title.trim() || isSubmitting}
            className="webapp-btn-primary px-5 py-2.5 text-sm"
          >
            {isSubmitting ? 'Creating...' : 'Create Issue'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
