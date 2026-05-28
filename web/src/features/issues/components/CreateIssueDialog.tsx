'use client';

import { useEffect, useMemo, useReducer, useState } from 'react';
import { Dialog } from '@/components/common/Dialog';
import { InlineNotice } from '@/components/common/InlineNotice';
import { useToast } from '@/components/common/FeedbackProvider';
import {
  DEFAULT_ISSUE_PRIORITY,
  ISSUE_PRIORITIES,
  ISSUE_PRIORITY_LABELS,
  ISSUE_STATUS_LABELS,
  type IssuePriorityValue,
} from '@/lib/issues/config';
import { useIssuesStore } from '../store';
import { useProjectsStore } from '@/features/projects';

const DEFAULT_STATUS = 'todo' as const;

type CreateIssueFormState = {
  title: string;
  description: string;
  priority: IssuePriorityValue;
  selectedProjectId: string | null;
  error: string | null;
};

type CreateIssueFormAction =
  | { type: 'set-title'; value: string }
  | { type: 'set-description'; value: string }
  | { type: 'set-priority'; value: IssuePriorityValue }
  | { type: 'set-project'; value: string | null }
  | { type: 'set-error'; value: string | null };

function createIssueFormReducer(
  state: CreateIssueFormState,
  action: CreateIssueFormAction,
): CreateIssueFormState {
  switch (action.type) {
    case 'set-title':
      return { ...state, title: action.value };
    case 'set-description':
      return { ...state, description: action.value };
    case 'set-priority':
      return { ...state, priority: action.value };
    case 'set-project':
      return { ...state, selectedProjectId: action.value };
    case 'set-error':
      return { ...state, error: action.value };
    default:
      return state;
  }
}

export function CreateIssueDialog({
  open,
  onClose,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string | null;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const projects = useProjectsStore((state) => state.projects);
  const fetchProjects = useProjectsStore((state) => state.fetchProjects);
  const createIssue = useIssuesStore((state) => state.createIssue);
  const { pushToast } = useToast();

  useEffect(() => {
    if (!open || projects.length > 0) {
      return;
    }
    void fetchProjects();
  }, [fetchProjects, open, projects.length]);

  const defaultProjectId = useMemo(
    () => projectId ?? projects.find((project) => project.isDefault)?.id ?? projects[0]?.id ?? null,
    [projectId, projects],
  );

  const handleClose = () => {
    if (isSubmitting) {
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Create Issue"
      maxWidthClassName="max-w-lg"
    >
      {open ? (
        <CreateIssueDialogContent
          projectId={projectId}
          defaultProjectId={defaultProjectId}
          projects={projects}
          createIssue={createIssue}
          isSubmitting={isSubmitting}
          setIsSubmitting={setIsSubmitting}
          onClose={onClose}
          pushToast={pushToast}
        />
      ) : null}
    </Dialog>
  );
}

function CreateIssueDialogContent({
  projectId,
  defaultProjectId,
  projects,
  createIssue,
  isSubmitting,
  setIsSubmitting,
  onClose,
  pushToast,
}: {
  projectId: string | null;
  defaultProjectId: string | null;
  projects: Array<{ id: string; name: string }>;
  createIssue: (input: {
    projectId: string;
    title: string;
    description: string | null;
    status: typeof DEFAULT_STATUS;
    priority: IssuePriorityValue;
  }) => Promise<unknown>;
  isSubmitting: boolean;
  setIsSubmitting: React.Dispatch<React.SetStateAction<boolean>>;
  onClose: () => void;
  pushToast: (payload: { title: string; description?: string; variant: 'success' | 'error' | 'warning' | 'info' }) => void;
}) {
  const [state, dispatch] = useReducer(createIssueFormReducer, {
    title: '',
    description: '',
    priority: DEFAULT_ISSUE_PRIORITY,
    selectedProjectId: null,
    error: null,
  });

  const showProjectPicker = !projectId;
  const hasSelectedProject = Boolean(
    state.selectedProjectId && projects.some((project) => project.id === state.selectedProjectId),
  );
  const effectiveProjectId = projectId ?? (hasSelectedProject ? state.selectedProjectId : defaultProjectId);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextTitle = state.title.trim();
    if (!effectiveProjectId || !nextTitle) {
      return;
    }

    setIsSubmitting(true);
    dispatch({ type: 'set-error', value: null });
    try {
      await createIssue({
        projectId: effectiveProjectId,
        title: nextTitle,
        description: state.description.trim() ? state.description.trim() : null,
        status: DEFAULT_STATUS,
        priority: state.priority,
      });
      pushToast({
        title: 'Issue created',
        description: `Added to ${ISSUE_STATUS_LABELS[DEFAULT_STATUS]}.`,
        variant: 'success',
      });
      onClose();
    } catch (error) {
      dispatch({
        type: 'set-error',
        value: error instanceof Error ? error.message : 'Failed to create issue.',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
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
            value={effectiveProjectId ?? ''}
            onChange={(event) => dispatch({ type: 'set-project', value: event.target.value || null })}
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
        <label htmlFor="create-issue-title" className="mb-2 block text-sm font-medium text-ink">Title</label>
        <input
          id="create-issue-title"
          type="text"
          aria-label="Issue title"
          value={state.title}
          onChange={(event) => dispatch({ type: 'set-title', value: event.target.value })}
          placeholder="Summarize the issue"
          className="w-full webapp-input"
        />
      </div>

      <div>
        <label htmlFor="create-issue-description" className="mb-2 block text-sm font-medium text-ink">Description</label>
        <textarea
          id="create-issue-description"
          aria-label="Issue description"
          value={state.description}
          onChange={(event) => dispatch({ type: 'set-description', value: event.target.value })}
          placeholder="Add context, acceptance criteria, or raw requirement notes"
          className="min-h-32 w-full resize-y webapp-input"
        />
      </div>

      <div>
        <label htmlFor="create-issue-priority" className="mb-2 block text-sm font-medium text-ink">Priority</label>
        <select
          id="create-issue-priority"
          value={state.priority}
          onChange={(event) => dispatch({
            type: 'set-priority',
            value: event.target.value as IssuePriorityValue,
          })}
          className="w-full webapp-input"
        >
          {ISSUE_PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {ISSUE_PRIORITY_LABELS[value]}
            </option>
          ))}
        </select>
      </div>

      {state.error ? (
        <InlineNotice variant="error" title="Issue creation failed">
          {state.error}
        </InlineNotice>
      ) : null}

      <div className="flex justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-4 py-2.5 text-sm text-muted transition-colors hover:bg-border/30 hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!effectiveProjectId || !state.title.trim() || isSubmitting}
          className="webapp-btn-primary px-5 py-2.5 text-sm"
        >
          {isSubmitting ? 'Creating...' : 'Create Issue'}
        </button>
      </div>
    </form>
  );
}
