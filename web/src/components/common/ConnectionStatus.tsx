'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useWebSocketStore } from '@/features/realtime';
import { useRuntimeStore } from '@/features/realtime';
import { useTasksStore } from '@/features/tasks';
import { useAgentsStore } from '@/features/agents';
import {
  extractGoalInfo,
  formatPercent,
  normalizeTaskId,
  resolveEffectiveAiMode,
} from './ConnectionStatus.utils';

export function ConnectionStatus({
  detailsEnabled = false,
  taskId: taskIdOverride,
}: {
  detailsEnabled?: boolean;
  taskId?: string | null;
}) {
  const status = useWebSocketStore((state) => state.status);
  const params = useParams<{ taskId?: string | string[] }>();
  const routeTaskId = useMemo(() => normalizeTaskId(params?.taskId), [params]);
  const taskId = taskIdOverride ?? routeTaskId;
  const runtime = useRuntimeStore((state) => (taskId ? state.byTask[taskId] : undefined));
  const agents = useAgentsStore((state) => state.agents);
  const currentTask = useTasksStore((state) => {
    if (!taskId) {
      return undefined;
    }
    return state.tasks.find((item) => item.id === taskId);
  });
  const daemonFromTask = currentTask?.executionHost || currentTask?.agentHost || undefined;
  const isPtyTask = currentTask?.taskType === 'pty_task';
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const statusConfig = {
    connected: {
      color: 'bg-[var(--success)]',
      pulse: false,
      label: 'Connected',
    },
    connecting: {
      color: 'bg-[var(--warning)]',
      pulse: true,
      label: 'Connecting...',
    },
    disconnected: {
      color: 'bg-[var(--error)]',
      pulse: false,
      label: 'Disconnected',
    },
  };

  const config = statusConfig[status];
  const visibleAgents = useMemo(
    () => agents.filter((agent) => !agent.host.startsWith('conductor-fire-')),
    [agents],
  );
  const visibleAgentByHost = useMemo(
    () => new Map(visibleAgents.map((agent) => [agent.host, agent] as const)),
    [visibleAgents],
  );
  const visibleAgentById = useMemo(
    () => new Map(visibleAgents.map((agent) => [agent.id, agent] as const)),
    [visibleAgents],
  );
  const daemon = useMemo(() => {
    const candidates = [daemonFromTask, runtime?.daemon]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      const hostMatch = visibleAgentByHost.get(candidate);
      if (hostMatch) {
        return hostMatch.host;
      }
      const idMatch = visibleAgentById.get(candidate);
      if (idMatch) {
        return idMatch.host;
      }
    }
    return candidates[0] || 'n/a';
  }, [daemonFromTask, runtime?.daemon, visibleAgentByHost, visibleAgentById]);
  const pid = runtime?.pid ?? null;
  const taskIdValue = taskId || 'n/a';
  const sessionId = runtime?.sessionId || runtime?.threadId || currentTask?.sessionId || 'n/a';
  const tokenUsagePercent = formatPercent(runtime?.tokenUsagePercent);
  const contextUsagePercent = formatPercent(runtime?.contextUsagePercent);
  const backend = runtime?.backend || currentTask?.backendType || 'n/a';
  const goalInfo = useMemo(
    () => extractGoalInfo(currentTask?.metadata, currentTask?.launchConfig),
    [currentTask?.metadata, currentTask?.launchConfig],
  );
  // Prefer the live runtime mode (set by fire on each dispatch). Fall back to
  // the task's persisted metadata.aiMode for the brief window before the
  // first turn has been dispatched (or for tasks where runtime hasn't
  // reported yet).
  const effectiveAiMode = resolveEffectiveAiMode(runtime?.aiMode, goalInfo.active);
  const aiModeLabel = effectiveAiMode === 'goal' ? 'goal' : 'normal';

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          if (!detailsEnabled) {
            return;
          }
          setOpen((prev) => !prev);
        }}
        className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--border)]/30 hover:bg-[var(--border)]/45 transition-colors"
        aria-label="Open connection details"
        aria-expanded={detailsEnabled ? open : undefined}
      >
        <span className="relative flex size-2.5">
          {config.pulse && (
            <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${config.color} opacity-75`} />
          )}
          <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${config.color}`} />
        </span>
        <span className="text-xs font-medium text-muted hidden sm:inline">
          {config.label}
        </span>
      </button>

      {detailsEnabled && open && (
        <div
          className={`absolute right-0 mt-2 w-[22rem] rounded-xl border backdrop-blur-md shadow-xl p-3 z-30 ${
            isPtyTask
              ? 'border-white/10 bg-zinc-950/70 text-white'
              : 'border-border bg-panel/70'
          }`}
        >
          <div className={`mb-2 text-xs font-semibold ${isPtyTask ? 'text-white' : 'text-ink'}`}>Runtime Details</div>
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-y-1 gap-x-2 text-xs">
            <span className={isPtyTask ? 'text-zinc-400' : 'text-muted'}>Connection</span>
            <span className={isPtyTask ? 'text-white' : 'text-ink'}>{config.label}</span>
            <span className={isPtyTask ? 'text-zinc-400' : 'text-muted'}>Task ID</span>
            <span className={`break-all ${isPtyTask ? 'text-white' : 'text-ink'}`}>{taskIdValue}</span>
            <span className={isPtyTask ? 'text-zinc-400' : 'text-muted'}>Daemon</span>
            <span className={`truncate ${isPtyTask ? 'text-white' : 'text-ink'}`} title={daemon}>{daemon}</span>
            <span className={isPtyTask ? 'text-zinc-400' : 'text-muted'}>PID</span>
            <span className={isPtyTask ? 'text-white' : 'text-ink'}>{pid ?? 'n/a'}</span>
            <span className={isPtyTask ? 'text-zinc-400' : 'text-muted'}>Backend</span>
            <span className={`truncate ${isPtyTask ? 'text-white' : 'text-ink'}`}>{backend}</span>
            <span className={isPtyTask ? 'text-zinc-400' : 'text-muted'}>AI Mode</span>
            <span
              data-testid="ai-mode-value"
              title={effectiveAiMode === 'goal' && goalInfo.objective ? goalInfo.objective : undefined}
              className={isPtyTask ? 'text-white' : 'text-ink'}
            >
              {aiModeLabel}
            </span>
            <span className={isPtyTask ? 'text-zinc-400' : 'text-muted'}>Session ID</span>
            <span className={`break-all ${isPtyTask ? 'text-white' : 'text-ink'}`}>{sessionId}</span>
            <span className={isPtyTask ? 'text-zinc-400' : 'text-muted'}>Token Usage</span>
            <span className={isPtyTask ? 'text-white' : 'text-ink'}>{tokenUsagePercent}</span>
            <span className={isPtyTask ? 'text-zinc-400' : 'text-muted'}>Context Usage</span>
            <span className={isPtyTask ? 'text-white' : 'text-ink'}>{contextUsagePercent}</span>
          </div>
        </div>
      )}
    </div>
  );
}
