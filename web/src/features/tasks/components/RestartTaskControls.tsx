'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
}

const isConductorFireHost = (host: string | null | undefined): boolean =>
  typeof host === 'string' && host.startsWith('conductor-fire-');

const isRestartableStatus = (status: Task['status']): boolean =>
  status === 'running' || status === 'completed' || status === 'killed' || status === 'unknown';

export function RestartTaskControls({ task, open, onClose }: RestartTaskControlsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const agents = useAgentsStore((state) => state.agents);
  const projects = useProjectsStore((state) => state.projects);
  const restartTask = useTasksStore((state) => state.restartTask);
  const { pushToast } = useToast();
  const [selectedBackend, setSelectedBackend] = useState(task.backendType ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const previousTaskIdRef = useRef(task.id);

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
  const sourceExecutionDaemonHost =
    isManualFireTask
      ? (
          (!isConductorFireHost(sourceMetadataDaemonHost) ? sourceMetadataDaemonHost : '') ||
          (sourceExecutionHost && !isConductorFireHost(sourceExecutionHost) ? sourceExecutionHost : '') ||
          (!isConductorFireHost(sourceProjectDaemonHost) ? sourceProjectDaemonHost : '')
        )
      : '';
  const restartSourceHost = isManualFireTask ? sourceExecutionDaemonHost : sourceAgentHost;
  const sourceAgent = useMemo(
    () => agents.find((agent) => agent.host === restartSourceHost) ?? null,
    [agents, restartSourceHost],
  );
  const supportedBackends = Array.isArray(sourceAgent?.supportedBackends)
    ? sourceAgent.supportedBackends
    : [];
  const backendOptions = useMemo(
    () => getCompatibleRestartBackends(currentBackend, supportedBackends),
    [currentBackend, supportedBackends],
  );
  const currentBackendSupported = currentBackend ? backendOptions.includes(currentBackend) : false;

  const getDefaultBackend = useCallback(() => {
    if (currentBackendSupported) {
      return currentBackend;
    }
    if (backendOptions.length > 0) {
      return backendOptions[0] || '';
    }
    return currentBackend;
  }, [backendOptions, currentBackend, currentBackendSupported]);

  useEffect(() => {
    if (!open) {
      return;
    }

    if (previousTaskIdRef.current !== task.id) {
      previousTaskIdRef.current = task.id;
      setSelectedBackend(getDefaultBackend());
      return;
    }

    setSelectedBackend((previousSelectedBackend) => {
      const normalizedPrevious =
        typeof previousSelectedBackend === 'string' ? previousSelectedBackend.trim() : '';

      if (normalizedPrevious && backendOptions.includes(normalizedPrevious)) {
        return normalizedPrevious;
      }

      return getDefaultBackend();
    });
  }, [backendOptions, currentBackend, currentBackendSupported, getDefaultBackend, open, task.id]);

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
    if (isManualFireTask && !sourceExecutionDaemonHost) {
      return 'Missing original daemon binding';
    }
    if (!isRestartableStatus(task.status)) {
      return 'Only running or stopped tasks can restart';
    }
    // Note: Fire tasks can always create new tasks; in-place restart is handled by the backend based on strategy
    if (!sourceAgent) {
      return isManualFireTask ? 'Original daemon is offline' : 'Source daemon is offline';
    }
    if (backendOptions.length === 0) {
      return isManualFireTask
        ? 'No compatible backend available on the original daemon'
        : 'No compatible backend available on the source daemon';
    }
    if (!selectedBackend) {
      return 'Select a backend first';
    }
    if (!canCreateSuccessorTask(currentBackend, selectedBackend)) {
      return `Creating a new task from ${currentBackend} to ${selectedBackend} is not supported`;
    }
    return null;
  }, [
    backendOptions.length,
    currentBackend,
    isManualFireTask,
    selectedBackend,
    sourceAgent,
    sourceAgentHost,
    sourceExecutionDaemonHost,
    sourceProjectDaemonHost,
    task.sessionId,
    task.status,
    task.taskType,
  ]);

  const navigateToTask = (nextTaskId: string) => {
    if (pathname === '/app/tasks') {
      const nextQuery = new URLSearchParams(searchParams?.toString() ?? '');
      nextQuery.set('taskId', nextTaskId);
      const query = nextQuery.toString();
      router.replace(query ? `/app/tasks?${query}` : '/app/tasks', { scroll: false });
      return;
    }
    router.push(`/app/tasks/${nextTaskId}`);
  };

  const handleRestart = async () => {
    if (disabledReason || !selectedBackend || isSubmitting) {
      return;
    }

    try {
      setIsSubmitting(true);
      const result = await restartTask(task.id, {
        backendType: selectedBackend,
        strategy: 'new_task',
      });
      navigateToTask(result.task.id);
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
          <label htmlFor={`restart-backend-${task.id}`} className="text-sm font-medium text-ink">
            Backend
          </label>
          <select
            id={`restart-backend-${task.id}`}
            value={selectedBackend}
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
