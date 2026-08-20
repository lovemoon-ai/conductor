'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { Task } from '@/shared/types';
import { useAgentsStore } from '@/features/agents';
import { useProjectsStore } from '@/features/projects';
import { useTasksStore } from '../store';
import {
  canCreateSuccessorTask,
  getCompatibleRestartBackends,
} from '@/lib/tasks/restart';
import { Dialog } from '@/components/common/Dialog';
import { useToast } from '@/components/common/FeedbackProvider';

interface RestartTaskControlsProps {
  task: Task;
  open: boolean;
  onClose: () => void;
  /**
   * Called with the newly created successor task id after a successful
   * new_task restart. When provided, this takes precedence over the internal
   * URL-only navigation so the caller can update local selection state (which
   * otherwise keeps the UI pinned to the source task). Falls back to
   * navigateToTask when absent.
   */
  onCreatedTask?: (taskId: string) => void;
}

const isConductorFireHost = (host: string | null | undefined): boolean =>
  typeof host === 'string' && host.startsWith('conductor-fire-');

const isRestartableStatus = (status: Task['status']): boolean =>
  status === 'running' || status === 'completed' || status === 'killed' || status === 'unknown';

export function RestartTaskControls({ task, open, onClose, onCreatedTask }: RestartTaskControlsProps) {
  const { push, replace } = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const agents = useAgentsStore((state) => state.agents);
  const projects = useProjectsStore((state) => state.projects);
  const restartTask = useTasksStore((state) => state.restartTask);
  const { pushToast } = useToast();
  const [selectedBackend, setSelectedBackend] = useState('');
  const [selectedDaemonHost, setSelectedDaemonHost] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const sourceAgentHost = typeof task.agentHost === 'string' ? task.agentHost.trim() : '';
  const sourceExecutionHost = typeof task.executionHost === 'string' ? task.executionHost.trim() : '';
  const sourceMetadataDaemonHost =
    task.metadata && typeof task.metadata.daemonName === 'string' ? task.metadata.daemonName.trim() : '';
  const sourceProjectDaemonHost = useMemo(() => {
    const projectId = typeof task.projectId === 'string' ? task.projectId.trim() : '';
    if (!projectId) {
      return '';
    }
    const project = projects.find((entry) => entry.id === projectId);
    return project && typeof project.daemonHost === 'string' ? project.daemonHost.trim() : '';
  }, [projects, task.projectId]);
  const currentBackend = typeof task.backendType === 'string' ? task.backendType.trim() : '';
  const isManualFireTask = isConductorFireHost(sourceAgentHost);
  // Daemon candidates that may hold the manual-fire task's workspace, in the
  // same priority order the server uses for auto-resolution.
  const manualFireDaemonCandidates = isManualFireTask
    ? [
        !isConductorFireHost(sourceMetadataDaemonHost) ? sourceMetadataDaemonHost : '',
        sourceExecutionHost && !isConductorFireHost(sourceExecutionHost) ? sourceExecutionHost : '',
        !isConductorFireHost(sourceProjectDaemonHost) ? sourceProjectDaemonHost : '',
      ].filter(Boolean)
    : [];
  const restartSourceHost = isManualFireTask
    ? manualFireDaemonCandidates[0] ?? ''
    : sourceAgentHost;
  // Online daemons the successor can run on. The agents store only lists
  // connected agents; fire connections are not spawn targets.
  const daemonOptions = useMemo(
    () => agents.filter((agent) => !isConductorFireHost(agent.host)).map((agent) => agent.host),
    [agents],
  );
  // Mirror the server's auto-resolution: the host it would pick without an
  // explicit override. A project daemon binding wins over everything (the
  // server forces it); otherwise fire tasks use the first ONLINE candidate
  // and normal tasks reuse the source daemon when it is online. No silent
  // fallback to an arbitrary other machine — when auto-resolution fails, the
  // user must explicitly pick a daemon (the branch then runs on a different
  // machine, which we never do behind their back).
  const projectDaemonCandidate = !isConductorFireHost(sourceProjectDaemonHost)
    ? sourceProjectDaemonHost
    : '';
  const autoResolvedDaemonHost = projectDaemonCandidate
    ? daemonOptions.includes(projectDaemonCandidate)
      ? projectDaemonCandidate
      : ''
    : isManualFireTask
      ? manualFireDaemonCandidates.find((host) => daemonOptions.includes(host)) ?? ''
      : restartSourceHost && daemonOptions.includes(restartSourceHost)
        ? restartSourceHost
        : '';
  const effectiveSelectedDaemonHost =
    selectedDaemonHost && daemonOptions.includes(selectedDaemonHost)
      ? selectedDaemonHost
      : autoResolvedDaemonHost;
  const isCrossDaemonSelection = Boolean(
    effectiveSelectedDaemonHost && effectiveSelectedDaemonHost !== restartSourceHost,
  );

  // A stale explicit choice must not silently survive a close/reopen.
  useEffect(() => {
    if (open) {
      setSelectedDaemonHost('');
    }
  }, [open]);
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.host === effectiveSelectedDaemonHost) ?? null,
    [agents, effectiveSelectedDaemonHost],
  );
  const supportedBackends = useMemo(
    () => (Array.isArray(selectedAgent?.supportedBackends) ? selectedAgent.supportedBackends : []),
    [selectedAgent],
  );
  const backendOptions = useMemo(
    () => getCompatibleRestartBackends(currentBackend, supportedBackends),
    [currentBackend, supportedBackends],
  );
  const currentBackendSupported = currentBackend ? backendOptions.includes(currentBackend) : false;

  const defaultBackend = useMemo(() => {
    if (currentBackendSupported) {
      return currentBackend;
    }
    if (backendOptions.length > 0) {
      return backendOptions[0] || '';
    }
    return currentBackend;
  }, [backendOptions, currentBackend, currentBackendSupported]);
  const effectiveSelectedBackend =
    selectedBackend && backendOptions.includes(selectedBackend)
      ? selectedBackend
      : defaultBackend;

  const disabledReason = useMemo(() => {
    if ((task.taskType ?? 'ai_task') !== 'ai_task') {
      return 'Only AI tasks support restart';
    }
    if (!currentBackend) {
      return 'Missing backend binding';
    }
    if (!task.sessionId) {
      return 'Missing session binding';
    }
    if (!sourceAgentHost) {
      return 'Missing source daemon binding';
    }
    if (!isRestartableStatus(task.status)) {
      return 'Only running or stopped tasks can restart';
    }
    // Note: Fire tasks can always create new tasks; in-place restart is handled by the backend based on strategy
    if (daemonOptions.length === 0) {
      return 'No daemon online';
    }
    if (!selectedAgent) {
      if (projectDaemonCandidate && !daemonOptions.includes(projectDaemonCandidate)) {
        return `Project daemon ${projectDaemonCandidate} is offline — select a daemon to run the new task`;
      }
      return restartSourceHost
        ? `Source daemon ${restartSourceHost} is offline — select a daemon to run the new task`
        : 'Select a daemon to run the new task';
    }
    if (backendOptions.length === 0) {
      return 'No compatible backend available on the selected daemon';
    }
    if (!effectiveSelectedBackend) {
      return 'Select a backend first';
    }
    if (!canCreateSuccessorTask(currentBackend, effectiveSelectedBackend)) {
      return `Creating a new task from ${currentBackend} to ${effectiveSelectedBackend} is not supported`;
    }
    return null;
  }, [
    backendOptions.length,
    currentBackend,
    daemonOptions,
    effectiveSelectedBackend,
    projectDaemonCandidate,
    restartSourceHost,
    selectedAgent,
    sourceAgentHost,
    task.sessionId,
    task.status,
    task.taskType,
  ]);

  const navigateToTask = (nextTaskId: string) => {
    if (pathname === '/app/tasks') {
      const nextQuery = new URLSearchParams(searchParams?.toString() ?? '');
      nextQuery.set('taskId', nextTaskId);
      const query = nextQuery.toString();
      replace(query ? `/app/tasks?${query}` : '/app/tasks', { scroll: false });
      return;
    }
    push(`/app/tasks/${nextTaskId}`);
  };

  const handleRestart = async () => {
    if (disabledReason || !effectiveSelectedBackend || isSubmitting) {
      return;
    }

    try {
      setIsSubmitting(true);
      // Omit the explicit override ONLY in the fully-trivial case: the shown
      // daemon is both what the server would auto-resolve AND the machine the
      // source task ran on — full parity with the pre-selector behavior. In
      // every other case send the displayed daemon explicitly, so the server
      // dispatches to exactly what the UI shows, and any target other than
      // the source machine goes through the cross-daemon path-drop guard
      // (making the warning below always truthful).
      const agentHostOverride =
        effectiveSelectedDaemonHost &&
        !(
          effectiveSelectedDaemonHost === autoResolvedDaemonHost &&
          effectiveSelectedDaemonHost === restartSourceHost
        )
          ? effectiveSelectedDaemonHost
          : undefined;
      const result = await restartTask(task.id, {
        backendType: effectiveSelectedBackend,
        strategy: 'new_task',
        ...(agentHostOverride ? { agentHost: agentHostOverride } : {}),
      });
      if (onCreatedTask) {
        onCreatedTask(result.task.id);
      } else {
        navigateToTask(result.task.id);
      }
      onClose();
    } catch (error) {
      pushToast({
        title: 'Failed to restart task',
        description: error instanceof Error ? error.message : 'Please try again in a moment.',
        variant: 'error',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New task from this"
      maxWidthClassName="max-w-lg"
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <label htmlFor={`restart-daemon-${task.id}`} className="text-sm font-medium text-ink">
            Daemon
          </label>
          <select
            id={`restart-daemon-${task.id}`}
            value={effectiveSelectedDaemonHost}
            onChange={(event) => setSelectedDaemonHost(event.target.value)}
            disabled={daemonOptions.length === 0 || isSubmitting}
            className="w-full rounded-xl border border-border bg-paper px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60"
          >
            {daemonOptions.length > 0 && !effectiveSelectedDaemonHost ? (
              <option value="" disabled>
                Select a daemon…
              </option>
            ) : null}
            {daemonOptions.map((host) => (
              <option key={host} value={host}>
                {host === restartSourceHost ? `${host} (current)` : host}
              </option>
            ))}
            {!daemonOptions.length ? <option value="">No daemon online</option> : null}
          </select>
          {isCrossDaemonSelection ? (
            <p className="text-xs text-muted">
              Runs on a different machine than the source task — starts from that daemon&apos;s own project path.
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <label htmlFor={`restart-backend-${task.id}`} className="text-sm font-medium text-ink">
            Backend
          </label>
          <select
            id={`restart-backend-${task.id}`}
            value={effectiveSelectedBackend}
            onChange={(event) => setSelectedBackend(event.target.value)}
            disabled={Boolean(disabledReason) || isSubmitting}
            className="w-full rounded-xl border border-border bg-paper px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60"
          >
            {backendOptions.map((backend) => (
              <option key={backend} value={backend}>
                {backend}
              </option>
            ))}
            {!backendOptions.length && currentBackend ? <option value={currentBackend}>{currentBackend}</option> : null}
          </select>
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
            onClick={() => void handleRestart()}
            disabled={Boolean(disabledReason) || isSubmitting}
            title={disabledReason ?? undefined}
            className="webapp-btn-primary rounded-xl px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? 'Working...' : 'New task'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
