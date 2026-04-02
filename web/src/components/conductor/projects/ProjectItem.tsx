'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Project } from '@/lib/conductor/types';
import { useProjectsStore } from '@/lib/conductor/stores/projects';
import { useAgentsStore } from '@/lib/conductor/stores/agents';
import { useSwipeActions } from '@/lib/conductor/hooks/useSwipeActions';
import { useConfirm, useToast } from '../common/FeedbackProvider';

interface ProjectItemProps {
  project: Project;
}

const ACTIONS_WIDTH = 144;

const EditIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
  </svg>
);

const TrashIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const CheckIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

const CloseIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
  </svg>
);

const readBindingCandidate = (
  metadata: Record<string, unknown> | null | undefined,
): { daemonHost: string; workspacePath: string } | null => {
  if (!metadata) {
    return null;
  }

  const rawCandidate =
    Object.prototype.hasOwnProperty.call(metadata, 'bindingCandidate')
      ? metadata.bindingCandidate
      : Object.prototype.hasOwnProperty.call(metadata, 'binding_candidate')
        ? metadata.binding_candidate
        : null;
  if (!rawCandidate || typeof rawCandidate !== 'object' || Array.isArray(rawCandidate)) {
    return null;
  }

  const candidate = rawCandidate as Record<string, unknown>;
  const daemonHost =
    typeof candidate.daemonHost === 'string'
      ? candidate.daemonHost.trim()
      : typeof candidate.daemon_host === 'string'
        ? candidate.daemon_host.trim()
        : '';
  const workspacePath =
    typeof candidate.workspacePath === 'string'
      ? candidate.workspacePath.trim()
      : typeof candidate.workspace_path === 'string'
        ? candidate.workspace_path.trim()
        : '';
  if (!daemonHost || !workspacePath) {
    return null;
  }

  return { daemonHost, workspacePath };
};

export function ProjectItem({ project }: ProjectItemProps) {
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(project.name);

  const { updateProject, deleteProject } = useProjectsStore();
  const agents = useAgentsStore((state) => state.agents);
  const { confirm } = useConfirm();
  const { pushToast } = useToast();

  const projectRecord = project as Project & Record<string, unknown>;
  const isDefault = Boolean(projectRecord.isDefault);
  const daemonHost = typeof projectRecord.daemonHost === 'string' ? projectRecord.daemonHost : null;
  const workspacePath = typeof projectRecord.workspacePath === 'string' ? projectRecord.workspacePath : null;
  const metadata = projectRecord.metadata && typeof projectRecord.metadata === 'object' && !Array.isArray(projectRecord.metadata)
    ? (projectRecord.metadata as Record<string, unknown>)
    : null;
  const bindingCandidate = readBindingCandidate(metadata);
  const isBoundProject = Boolean(daemonHost) && !isDefault;
  const isPendingBinding = !isDefault && !daemonHost;
  const isDaemonOnline = !daemonHost || agents.some((agent) => agent.host === daemonHost);
  const isUnavailable = isBoundProject && !isDaemonOnline;
  const pendingBindingLabel = bindingCandidate
    ? `${bindingCandidate.daemonHost} / ${bindingCandidate.workspacePath}`
    : null;
  const swipe = useSwipeActions({
    maxOffset: isDefault ? 0 : ACTIONS_WIDTH,
  });

  const openProjectTasks = () => {
    if (isPendingBinding) {
      pushToast({
        title: 'Project binding pending',
        description: pendingBindingLabel
          ? `Daemon ${pendingBindingLabel} has not confirmed this workspace yet.`
          : 'Bind this project from the daemon/CLI before opening tasks.',
        variant: 'warning',
      });
      return;
    }
    if (isUnavailable) {
      pushToast({
        title: 'Project unavailable',
        description: `Daemon ${daemonHost} is offline. Reconnect it to open this workspace.`,
        variant: 'warning',
      });
      return;
    }
    router.push(`/app/tasks?projectId=${encodeURIComponent(project.id)}`);
  };

  const handleRename = async () => {
    const nextName = editName.trim();
    if (!nextName) return;

    if (nextName !== project.name) {
      try {
        await updateProject(project.id, { name: nextName });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to rename project';
        pushToast({
          title: 'Failed to rename project',
          description: message,
          variant: 'error',
        });
        return;
      }
    }
    setIsEditing(false);
    swipe.closeActions();
  };

  const handleCancelRename = () => {
    setEditName(project.name);
    setIsEditing(false);
    swipe.closeActions();
  };

  const handleDelete = async () => {
    if (isDefault) {
      pushToast({
        title: 'Cannot delete the default project',
        variant: 'warning',
      });
      return;
    }
    const accepted = await confirm({
      title: `Delete project "${project.name}"?`,
      description: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (accepted) {
      try {
        await deleteProject(project.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete project';
        pushToast({
          title: 'Failed to delete project',
          description: message,
          variant: 'error',
        });
      }
    }
    swipe.closeActions();
  };

  if (isEditing) {
    return (
      <div className="webapp-card p-4">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleRename();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                handleCancelRename();
              }
            }}
            className="flex-1 webapp-input"
            autoFocus
          />
          <button
            type="button"
            aria-label="Cancel rename"
            title="Cancel"
            onClick={handleCancelRename}
            className="w-8 h-8 inline-flex items-center justify-center rounded border border-[var(--border)] text-muted hover:text-ink hover:bg-[var(--paper)] transition-colors"
          >
            <CloseIcon />
          </button>
          <button
            type="button"
            aria-label="Confirm rename"
            title="Confirm"
            disabled={!editName.trim()}
            onClick={() => void handleRename()}
            className="w-8 h-8 inline-flex items-center justify-center rounded border border-[var(--border)] text-[var(--accent)] hover:bg-[var(--accent)]/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <CheckIcon />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-2xl">
      {!isDefault && (
        <div className="absolute inset-y-0 right-0 flex z-0" aria-hidden={!swipe.isOpen}>
          <button
            type="button"
            tabIndex={swipe.isOpen ? 0 : -1}
            aria-label="Rename project"
            title="Rename"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsEditing(true);
              swipe.closeActions();
            }}
            className="w-[72px] h-full flex items-center justify-center border-l border-border bg-[var(--paper)] text-muted hover:text-ink transition-colors"
          >
            <EditIcon />
          </button>
          <button
            type="button"
            tabIndex={swipe.isOpen ? 0 : -1}
            aria-label="Delete project"
            title="Delete"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void handleDelete();
            }}
            className="w-[72px] h-full flex items-center justify-center border-l border-border bg-[var(--error)]/10 text-[var(--error)] hover:bg-[var(--error)]/20 transition-colors"
          >
            <TrashIcon />
          </button>
        </div>
      )}

      <div
        onClick={() => {
          if (swipe.consumeTap()) {
            return;
          }
          openProjectTasks();
        }}
        className={`webapp-card relative z-10 px-4 pb-4 pt-4 transition-colors ${
          isUnavailable || isPendingBinding ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:border-[var(--accent)]'
        }`}
        role="button"
        tabIndex={0}
        aria-disabled={isUnavailable || isPendingBinding}
        onPointerDown={swipe.onPointerDown}
        onPointerMove={swipe.onPointerMove}
        onPointerUp={swipe.onPointerUp}
        onPointerCancel={swipe.onPointerCancel}
        style={swipe.panelStyle}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            swipe.closeActions();
            return;
          }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (swipe.isOpen) {
              swipe.closeActions();
              return;
            }
            openProjectTasks();
          }
        }}
      >
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${isDefault ? 'webapp-gradient-bg' : 'bg-accent/10'}`}>
            <svg className={`w-5 h-5 ${isDefault ? 'text-white' : 'text-accent'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-medium">{project.name}</h3>
              {isUnavailable ? (
                <span className="rounded-full bg-[var(--warning)]/10 px-2 py-0.5 text-[11px] font-medium text-ink">
                  Daemon offline
                </span>
              ) : isPendingBinding ? (
                <span className="rounded-full bg-border/50 px-2 py-0.5 text-[11px] font-medium text-muted">
                  Binding pending
                </span>
              ) : null}
            </div>
            {project.description && (
              <p className="text-sm text-muted mt-0.5">{project.description}</p>
            )}
            {isDefault ? (
              <p className="mt-1 text-xs text-muted">Default workspace</p>
            ) : isPendingBinding ? (
              <p className="mt-1 text-xs text-muted">
                {pendingBindingLabel
                  ? `Awaiting daemon confirmation for ${pendingBindingLabel}`
                  : 'Awaiting daemon confirmation'}
              </p>
            ) : isBoundProject ? (
              <p className="mt-1 text-xs text-muted">
                {daemonHost}
                {workspacePath ? ` / ${workspacePath}` : ''}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
