'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { StartTaskRoundInput, Task } from '@/shared/types';
import { useAgentsStore } from '@/features/agents';
import { useProjectsStore } from '@/features/projects';
import { Dialog } from '@/components/common/Dialog';
import { useToast } from '@/components/common/FeedbackProvider';
import { readPersistentTaskState } from '@/shared/utils/persistent-task';
import { useTasksStore } from '../store';

const isConductorFireHost = (host: string | null | undefined): boolean =>
  typeof host === 'string' && host.startsWith('conductor-fire-');

const fieldClassName =
  'w-full rounded-xl border border-border bg-paper px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60';

interface PersistentTaskDialogProps {
  task: Task;
  open: boolean;
  onClose: () => void;
}

/** RFC 0039: turn persistence on/off and edit the standing instructions and rolling summary. */
export function PersistentTaskSettingsDialog({ task, open, onClose }: PersistentTaskDialogProps) {
  const fetchTask = useTasksStore((state) => state.fetchTask);
  const updateTaskPersistent = useTasksStore((state) => state.updateTaskPersistent);
  const { pushToast } = useToast();
  const [enabled, setEnabled] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [summary, setSummary] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Fields the user edited: the refresh below must not overwrite them, and Save
  // sends only these so an untouched summary cannot clobber a newer AI summary.
  const touched = useRef(new Set<'enabled' | 'instructions' | 'summary'>());

  useEffect(() => {
    if (!open) return;
    touched.current.clear();
    const apply = (source: Task) => {
      const state = readPersistentTaskState(source.metadata);
      if (!touched.current.has('enabled')) setEnabled(state?.enabled ?? false);
      if (!touched.current.has('instructions')) setInstructions(state?.instructions ?? '');
      if (!touched.current.has('summary')) setSummary(state?.summary ?? '');
    };
    apply(task);
    // The summary is written server-side when the AI replies; pull the latest.
    let cancelled = false;
    void fetchTask(task.id).then((fresh) => {
      if (fresh && !cancelled) apply(fresh);
    });
    return () => {
      cancelled = true;
    };
    // Only re-seed when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task.id]);

  const handleSave = async () => {
    const edited = touched.current;
    const input = {
      ...(edited.has('enabled') ? { enabled } : {}),
      ...(edited.has('instructions') ? { instructions } : {}),
      ...(edited.has('summary') ? { summary } : {}),
    };
    if (Object.keys(input).length === 0) {
      onClose();
      return;
    }
    setIsSubmitting(true);
    try {
      await updateTaskPersistent(task.id, input);
      onClose();
    } catch (error) {
      pushToast({
        title: 'Failed to save persistent task settings',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'error',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Persistent task" maxWidthClassName="max-w-lg">
      <div className="space-y-5">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            aria-label="Persistent task"
            checked={enabled}
            onChange={(event) => {
              touched.current.add('enabled');
              setEnabled(event.target.checked);
            }}
            disabled={isSubmitting}
            className="mt-0.5 size-4 rounded border-border text-[var(--accent)] focus:ring-[var(--accent)]"
          />
          <div className="min-w-0">
            <span className="text-sm font-medium text-ink">Persistent task</span>
            <p className="mt-1 text-xs text-muted">
              Work in rounds: each round starts a fresh AI session that only receives the instructions and summary below.
            </p>
          </div>
        </label>

        <div className="space-y-2">
          <label htmlFor={`persistent-instructions-${task.id}`} className="text-sm font-medium text-ink">
            Standing instructions
          </label>
          <textarea
            id={`persistent-instructions-${task.id}`}
            value={instructions}
            onChange={(event) => {
              touched.current.add('instructions');
              setInstructions(event.target.value);
            }}
            disabled={isSubmitting}
            rows={4}
            className={fieldClassName}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor={`persistent-summary-${task.id}`} className="text-sm font-medium text-ink">
            Summary of previous rounds
          </label>
          <textarea
            id={`persistent-summary-${task.id}`}
            value={summary}
            onChange={(event) => {
              touched.current.add('summary');
              setSummary(event.target.value);
            }}
            disabled={isSubmitting}
            rows={6}
            className={fieldClassName}
          />
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-paper hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSubmitting}
            className="webapp-btn-primary rounded-xl px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

interface NewRoundDialogProps extends PersistentTaskDialogProps {
  /** Shared with the composer's idle send so both paths reset the chat the same way. */
  onStartRound: (input: Omit<StartTaskRoundInput, 'expectedRound'>) => Promise<void>;
}

/** RFC 0039: start a new round, choosing daemon, backend and workspace. */
export function NewRoundDialog({ task, open, onClose, onStartRound }: NewRoundDialogProps) {
  const agents = useAgentsStore((state) => state.agents);
  const projects = useProjectsStore((state) => state.projects);
  const { pushToast } = useToast();
  const [selectedDaemonHost, setSelectedDaemonHost] = useState('');
  const [selectedBackend, setSelectedBackend] = useState('');
  const [worktree, setWorktree] = useState<NonNullable<StartTaskRoundInput['worktree']>>('inherit');
  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedDaemonHost('');
      setSelectedBackend('');
      setWorktree('inherit');
    }
  }, [open]);

  const projectDaemonHost = useMemo(() => {
    const project = projects.find((entry) => entry.id === task.projectId);
    const host = project?.daemonHost?.trim() ?? '';
    return isConductorFireHost(host) ? '' : host;
  }, [projects, task.projectId]);
  const previousHost = [task.agentHost, task.metadata?.daemonName]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find((host) => host && !isConductorFireHost(host)) ?? '';
  const daemonOptions = useMemo(
    () => agents.filter((agent) => !isConductorFireHost(agent.host)).map((agent) => agent.host),
    [agents],
  );
  // Same default as the server: keep the previous round's daemon.
  const defaultDaemonHost = previousHost || projectDaemonHost;
  const daemonHost = selectedDaemonHost || defaultDaemonHost;
  const backendOptions = useMemo(
    () => agents.find((agent) => agent.host === daemonHost)?.supportedBackends ?? [],
    [agents, daemonHost],
  );
  const currentBackend = task.backendType?.trim() ?? '';
  const backend =
    selectedBackend && backendOptions.includes(selectedBackend)
      ? selectedBackend
      : backendOptions.includes(currentBackend)
        ? currentBackend
        : backendOptions[0] ?? '';

  const disabledReason = !daemonOptions.includes(daemonHost)
    ? daemonHost
      ? `Daemon ${daemonHost} is offline — select another daemon`
      : 'Select a daemon'
    : !backend
      ? 'No backend available on the selected daemon'
      : !content.trim()
        ? 'Enter the first message of the round'
        : null;

  const handleStart = async () => {
    if (disabledReason || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onStartRound({
        content: content.trim(),
        backendType: backend,
        ...(daemonHost !== defaultDaemonHost ? { agentHost: daemonHost } : {}),
        worktree,
      });
      setContent('');
      onClose();
    } catch (error) {
      pushToast({
        title: 'Failed to start a new round',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'error',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="New round" maxWidthClassName="max-w-lg">
      <div className="space-y-5">
        <div className="space-y-2">
          <label htmlFor={`round-daemon-${task.id}`} className="text-sm font-medium text-ink">
            Daemon
          </label>
          <select
            id={`round-daemon-${task.id}`}
            value={daemonHost}
            onChange={(event) => setSelectedDaemonHost(event.target.value)}
            disabled={isSubmitting}
            className={fieldClassName}
          >
            {!daemonOptions.includes(daemonHost) ? (
              <option value={daemonHost} disabled>
                {daemonHost ? `${daemonHost} (offline)` : 'Select a daemon…'}
              </option>
            ) : null}
            {daemonOptions.map((host) => (
              <option key={host} value={host}>
                {host === previousHost ? `${host} (current)` : host}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label htmlFor={`round-backend-${task.id}`} className="text-sm font-medium text-ink">
            Backend
          </label>
          <select
            id={`round-backend-${task.id}`}
            value={backend}
            onChange={(event) => setSelectedBackend(event.target.value)}
            disabled={isSubmitting || backendOptions.length === 0}
            className={fieldClassName}
          >
            {backendOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label htmlFor={`round-worktree-${task.id}`} className="text-sm font-medium text-ink">
            Workspace
          </label>
          <select
            id={`round-worktree-${task.id}`}
            value={worktree}
            onChange={(event) => setWorktree(event.target.value as typeof worktree)}
            disabled={isSubmitting}
            className={fieldClassName}
          >
            <option value="inherit">Same as the previous round</option>
            <option value="new">New worktree</option>
            <option value="none">Project directory (no worktree)</option>
          </select>
        </div>

        <div className="space-y-2">
          <label htmlFor={`round-content-${task.id}`} className="text-sm font-medium text-ink">
            First message
          </label>
          <textarea
            id={`round-content-${task.id}`}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            disabled={isSubmitting}
            rows={4}
            className={fieldClassName}
          />
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-paper hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleStart()}
            disabled={Boolean(disabledReason) || isSubmitting}
            title={disabledReason ?? undefined}
            className="webapp-btn-primary rounded-xl px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? 'Starting...' : 'Start round'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
