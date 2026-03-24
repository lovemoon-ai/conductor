'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import type { Task } from '@/lib/conductor/types';
import { useAgentsStore } from '@/lib/conductor/stores/agents';
import { useTasksStore } from '@/lib/conductor/stores/tasks';
import { useRuntimeStore } from '@/lib/conductor/stores/runtime';
import { useToast } from '../common/FeedbackProvider';

interface RestartTaskControlsProps {
  task: Task;
  compact?: boolean;
}

const isStoppedAiTask = (task: Task): boolean =>
  (task.taskType ?? 'ai_task') === 'ai_task' &&
  (task.status === 'completed' || task.status === 'killed');

const isConductorFireHost = (host: string | null | undefined): boolean =>
  typeof host === 'string' && host.startsWith('conductor-fire-');

export function RestartTaskControls({ task, compact = false }: RestartTaskControlsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const agents = useAgentsStore((state) => state.agents);
  const restartTask = useTasksStore((state) => state.restartTask);
  const clearRuntime = useRuntimeStore((state) => state.clearTask);
  const { pushToast } = useToast();
  const [selectedBackend, setSelectedBackend] = useState(task.backendType ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const previousTaskIdRef = useRef(task.id);

  const sourceAgentHost = typeof task.agentHost === 'string' ? task.agentHost.trim() : '';
  const currentBackend = typeof task.backendType === 'string' ? task.backendType.trim() : '';
  const sourceAgent = useMemo(
    () => agents.find((agent) => agent.host === sourceAgentHost) ?? null,
    [agents, sourceAgentHost],
  );
  const backendOptions = sourceAgent?.supportedBackends ?? [];
  const currentBackendSupported = currentBackend ? backendOptions.includes(currentBackend) : false;
  const getDefaultSelectedBackend = () => {
    if (currentBackendSupported) {
      return currentBackend;
    }
    if (backendOptions.length > 0) {
      return backendOptions[0] || '';
    }
    return currentBackend;
  };

  useEffect(() => {
    if (previousTaskIdRef.current !== task.id) {
      previousTaskIdRef.current = task.id;
      setSelectedBackend(getDefaultSelectedBackend());
      return;
    }

    setSelectedBackend((previousSelectedBackend) => {
      const normalizedPrevious =
        typeof previousSelectedBackend === 'string' ? previousSelectedBackend.trim() : '';

      if (normalizedPrevious && backendOptions.includes(normalizedPrevious)) {
        return normalizedPrevious;
      }

      return getDefaultSelectedBackend();
    });
  }, [backendOptions, currentBackend, currentBackendSupported, task.id]);

  if (!isStoppedAiTask(task)) {
    return null;
  }

  let disabledReason: string | null = null;
  if (!currentBackend) {
    disabledReason = 'Missing backend binding';
  } else if (!task.sessionId) {
    disabledReason = 'Missing session binding';
  } else if (!sourceAgentHost) {
    disabledReason = 'Missing source daemon binding';
  } else if (isConductorFireHost(sourceAgentHost)) {
    disabledReason = 'Manual fire task does not support in-app restart yet';
  } else if (!sourceAgent) {
    disabledReason = 'Source daemon is offline';
  } else if (backendOptions.length === 0) {
    disabledReason = 'No backend available on the source daemon';
  } else if (!selectedBackend) {
    disabledReason = 'Select a backend first';
  }

  const buttonLabel = selectedBackend === currentBackend ? 'Restart' : 'Switch Backend';
  const stopEventPropagation = (event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>) => {
    event.stopPropagation();
  };
  const stopKeyboardPropagation = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
  };

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
      const result = await restartTask(
        task.id,
        selectedBackend === currentBackend ? undefined : selectedBackend,
      );
      if (result.mode === 'inplace_restart') {
        clearRuntime(task.id);
        return;
      }
      navigateToTask(result.task.id);
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
    <div
      onClick={stopEventPropagation}
      onPointerDown={stopEventPropagation}
      onKeyDown={stopKeyboardPropagation}
      className={`flex flex-col gap-2 ${compact ? 'mt-3' : 'border-b border-border bg-paper px-4 py-3'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Restart backend"
          value={selectedBackend}
          onChange={(event) => setSelectedBackend(event.target.value)}
          disabled={Boolean(disabledReason) || isSubmitting}
          className={`rounded-lg border border-border bg-paper px-2 py-1 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60 ${
            compact ? 'min-w-[7rem]' : 'min-w-[8rem]'
          }`}
        >
          {backendOptions.map((backend) => (
            <option key={backend} value={backend}>
              {backend}
            </option>
          ))}
          {!backendOptions.length && currentBackend ? <option value={currentBackend}>{currentBackend}</option> : null}
        </select>
        <button
          type="button"
          onClick={() => void handleRestart()}
          disabled={Boolean(disabledReason) || isSubmitting}
          className="webapp-btn-primary rounded-lg px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? 'Working...' : buttonLabel}
        </button>
      </div>
      {disabledReason ? (
        <p className="text-xs text-muted">{disabledReason}</p>
      ) : sourceAgent && currentBackend && !currentBackendSupported && selectedBackend ? (
        <p className="text-xs text-muted">
          Current backend is no longer supported on the source daemon. Switch to {selectedBackend} to continue.
        </p>
      ) : selectedBackend !== currentBackend ? (
        <p className="text-xs text-muted">A new successor task will be created on {selectedBackend}.</p>
      ) : null}
    </div>
  );
}
