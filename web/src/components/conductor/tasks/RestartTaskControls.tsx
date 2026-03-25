'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { Task } from '@/lib/conductor/types';
import { useAgentsStore } from '@/lib/conductor/stores/agents';
import { useTasksStore } from '@/lib/conductor/stores/tasks';
import { useRuntimeStore } from '@/lib/conductor/stores/runtime';
import {
  canCreateSuccessorTask,
  canInplaceRestart,
  getCompatibleRestartBackends,
  STOPPED_TASK_STATUSES,
  type RestartStrategy,
} from '@/lib/tasks/restart';
import { Dialog } from '../common/Dialog';
import { useToast } from '../common/FeedbackProvider';

interface RestartTaskControlsProps {
  task: Task;
  open: boolean;
  onClose: () => void;
}

const isConductorFireHost = (host: string | null | undefined): boolean =>
  typeof host === 'string' && host.startsWith('conductor-fire-');

const isRestartableStatus = (status: Task['status']): boolean =>
  status === 'running' || status === 'completed' || status === 'killed';

export function RestartTaskControls({ task, open, onClose }: RestartTaskControlsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const agents = useAgentsStore((state) => state.agents);
  const restartTask = useTasksStore((state) => state.restartTask);
  const clearRuntime = useRuntimeStore((state) => state.clearTask);
  const { pushToast } = useToast();
  const [selectedBackend, setSelectedBackend] = useState(task.backendType ?? '');
  const [selectedStrategy, setSelectedStrategy] = useState<RestartStrategy>('new_task');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const previousTaskIdRef = useRef(task.id);

  const sourceAgentHost = typeof task.agentHost === 'string' ? task.agentHost.trim() : '';
  const sourceExecutionHost = typeof task.executionHost === 'string' ? task.executionHost.trim() : '';
  const currentBackend = typeof task.backendType === 'string' ? task.backendType.trim() : '';
  const isManualFireTask = isConductorFireHost(sourceAgentHost);
  const sourceExecutionDaemonHost =
    isManualFireTask && sourceExecutionHost && !isConductorFireHost(sourceExecutionHost)
      ? sourceExecutionHost
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

  useEffect(() => {
    if (!open) {
      return;
    }

    setSelectedStrategy((previousStrategy) => {
      if (previousStrategy === 'inplace' && canInplaceRestart(task.status, currentBackend, selectedBackend)) {
        return previousStrategy;
      }
      return canInplaceRestart(task.status, currentBackend, selectedBackend) ? 'inplace' : 'new_task';
    });
  }, [currentBackend, open, selectedBackend, task.status]);

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
    if (isManualFireTask && !STOPPED_TASK_STATUSES.has(task.status)) {
      return 'Manual fire tasks can only restart after they stop';
    }
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
    if (selectedStrategy === 'inplace' && !canInplaceRestart(task.status, currentBackend, selectedBackend)) {
      return 'In-place restart is only available for stopped tasks on the current backend';
    }
    if (selectedStrategy === 'new_task' && !canCreateSuccessorTask(currentBackend, selectedBackend)) {
      return `Creating a new task from ${currentBackend} to ${selectedBackend} is not supported`;
    }
    return null;
  }, [
    backendOptions.length,
    currentBackend,
    isManualFireTask,
    selectedBackend,
    selectedStrategy,
    sourceAgent,
    sourceAgentHost,
    sourceExecutionDaemonHost,
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
        strategy: selectedStrategy,
      });
      if (result.mode === 'inplace_restart') {
        clearRuntime(task.id);
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

  const submitLabel = selectedStrategy === 'inplace' ? 'Restart in place' : 'Create new task';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Restart task"
      maxWidthClassName="max-w-lg"
    >
      <div className="space-y-5">
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-ink">Continue as</legend>
          <div className="grid grid-cols-2 gap-3">
            <label className={`flex items-center gap-3 rounded-xl border px-3 py-3 ${selectedStrategy === 'inplace' ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-border bg-paper'}`}>
              <input
                id={`restart-strategy-inplace-${task.id}`}
                type="radio"
                name={`restart-strategy-${task.id}`}
                value="inplace"
                aria-label="In place"
                checked={selectedStrategy === 'inplace'}
                disabled={!canInplaceRestart(task.status, currentBackend, selectedBackend) || isSubmitting}
                onChange={() => setSelectedStrategy('inplace')}
              />
              <span className="min-w-0 text-sm font-medium text-ink">In place</span>
            </label>
            <label className={`flex items-center gap-3 rounded-xl border px-3 py-3 ${selectedStrategy === 'new_task' ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-border bg-paper'}`}>
              <input
                id={`restart-strategy-new-task-${task.id}`}
                type="radio"
                name={`restart-strategy-${task.id}`}
                value="new_task"
                aria-label="New task"
                checked={selectedStrategy === 'new_task'}
                disabled={!canCreateSuccessorTask(currentBackend, selectedBackend) || isSubmitting}
                onChange={() => setSelectedStrategy('new_task')}
              />
              <span className="min-w-0 text-sm font-medium text-ink">New task</span>
            </label>
          </div>
        </fieldset>

        <div className="space-y-2">
          <label htmlFor={`restart-backend-${task.id}`} className="text-sm font-medium text-ink">
            Backend
          </label>
          <select
            id={`restart-backend-${task.id}`}
            aria-label="Restart backend"
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
            {isSubmitting ? 'Working...' : submitLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
