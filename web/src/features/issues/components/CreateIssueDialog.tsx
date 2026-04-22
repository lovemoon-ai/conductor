'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/common/Dialog';
import { InlineNotice } from '@/components/common/InlineNotice';
import { useToast } from '@/components/common/FeedbackProvider';
import { DEFAULT_ISSUE_PRIORITY, ISSUE_STATUS_LABELS } from '@/lib/issues/config';
import { useIssuesStore } from '../store';
import { useProjectsStore } from '@/features/projects';

const DEFAULT_STATUS = 'todo' as const;

export function CreateIssueDialog({
  open,
  onClose,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string | null;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(projectId);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const projects = useProjectsStore((state) => state.projects);
  const fetchProjects = useProjectsStore((state) => state.fetchProjects);
  const createIssue = useIssuesStore((state) => state.createIssue);
  const error = useIssuesStore((state) => state.error);
  const clearError = useIssuesStore((state) => state.clearError);
  const { pushToast } = useToast();

  const defaultProjectId = useMemo(
    () => projectId ?? projects.find((project) => project.isDefault)?.id ?? projects[0]?.id ?? null,
    [projectId, projects],
  );
  const effectiveProjectId = projectId ?? selectedProjectId;
  const showProjectPicker = !projectId;

  useEffect(() => {
    if (!open) {
      return;
    }
    setTitle('');
    setDescription('');
    clearError();
  }, [clearError, open]);

  useEffect(() => {
    if (!open || projects.length > 0) {
      return;
    }
    void fetchProjects();
  }, [fetchProjects, open, projects.length]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (projectId) {
      setSelectedProjectId(projectId);
      return;
    }
    setSelectedProjectId((current) => (
      current && projects.some((project) => project.id === current)
        ? current
        : defaultProjectId
    ));
  }, [defaultProjectId, open, projectId, projects]);

  const handleClose = () => {
    if (isSubmitting) {
      return;
    }
    onClose();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!effectiveProjectId || !title.trim()) {
      return;
    }

    setIsSubmitting(true);
    try {
      await createIssue({
        projectId: effectiveProjectId,
        title: title.trim(),
        description: description.trim() ? description.trim() : null,
        status: DEFAULT_STATUS,
        priority: DEFAULT_ISSUE_PRIORITY,
      });
      pushToast({
        title: 'Issue created',
        description: `Added to ${ISSUE_STATUS_LABELS[DEFAULT_STATUS]}.`,
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
      maxWidthClassName="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {!effectiveProjectId ? (
          <InlineNotice variant="warning" title="No project available">
            Select a project before creating an issue.
          </InlineNotice>
        ) : null}

        {showProjectPicker ? (
          <div>
            <label htmlFor="create-issue-project" className="mb-2 block text-sm font-medium text-ink">
              Project
            </label>
            <select
              id="create-issue-project"
              value={selectedProjectId ?? ''}
              onChange={(event) => setSelectedProjectId(event.target.value || null)}
              disabled={projects.length === 0}
              className="w-full webapp-input"
            >
              <option value="" disabled>
                {projects.length === 0 ? 'No projects available' : 'Select a project'}
              </option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
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
            disabled={!effectiveProjectId || !title.trim() || isSubmitting}
            className="webapp-btn-primary px-5 py-2.5 text-sm"
          >
            {isSubmitting ? 'Creating...' : 'Create Issue'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
