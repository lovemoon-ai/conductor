'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useWebSocketStore } from '@/lib/conductor/stores/websocket';
import { useRuntimeStore } from '@/lib/conductor/stores/runtime';
import { useTasksStore } from '@/lib/conductor/stores/tasks';
import { useAgentsStore } from '@/lib/conductor/stores/agents';

function normalizeTaskId(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] || null;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return null;
}

function formatPercent(value?: number): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  const rounded = Math.round((Number(value) + Number.EPSILON) * 10) / 10;
  return `${rounded}%`;
}

export function ConnectionStatus({ detailsEnabled = false }: { detailsEnabled?: boolean }) {
  const status = useWebSocketStore((state) => state.status);
  const params = useParams<{ taskId?: string | string[] }>();
  const taskId = useMemo(() => normalizeTaskId(params?.taskId), [params]);
  const runtime = useRuntimeStore((state) => (taskId ? state.byTask[taskId] : undefined));
  const agents = useAgentsStore((state) => state.agents);
  const daemonFromTask = useTasksStore((state) => {
    if (!taskId) {
      return undefined;
    }
    const task = state.tasks.find((item) => item.id === taskId);
    return task?.executionHost || task?.agentHost || undefined;
  });
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
  const daemon = useMemo(() => {
    const candidates = [daemonFromTask, runtime?.daemon]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      const hostMatch = visibleAgents.find((agent) => agent.host === candidate);
      if (hostMatch) {
        return hostMatch.host;
      }
      const idMatch = visibleAgents.find((agent) => agent.id === candidate);
      if (idMatch) {
        return idMatch.host;
      }
    }
    return candidates[0] || 'n/a';
  }, [daemonFromTask, runtime?.daemon, visibleAgents]);
  const pid = runtime?.pid ?? null;
  const taskIdValue = taskId || 'n/a';
  const sessionId = runtime?.sessionId || runtime?.threadId || 'n/a';
  const tokenUsagePercent = formatPercent(runtime?.tokenUsagePercent);
  const contextUsagePercent = formatPercent(runtime?.contextUsagePercent);
  const backend = runtime?.backend || 'n/a';

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
        <span className="relative flex h-2.5 w-2.5">
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
        <div className="absolute right-0 mt-2 w-[22rem] rounded-xl border border-border bg-panel/70 backdrop-blur-md shadow-xl p-3 z-30">
          <div className="text-xs font-semibold text-ink mb-2">Runtime Details</div>
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-y-1 gap-x-2 text-xs">
            <span className="text-muted">Connection</span>
            <span className="text-ink">{config.label}</span>
            <span className="text-muted">Task ID</span>
            <span className="text-ink break-all">{taskIdValue}</span>
            <span className="text-muted">Daemon</span>
            <span className="text-ink truncate" title={daemon}>{daemon}</span>
            <span className="text-muted">PID</span>
            <span className="text-ink">{pid ?? 'n/a'}</span>
            <span className="text-muted">Backend</span>
            <span className="text-ink truncate">{backend}</span>
            <span className="text-muted">Session ID</span>
            <span className="text-ink break-all">{sessionId}</span>
            <span className="text-muted">Token Usage</span>
            <span className="text-ink">{tokenUsagePercent}</span>
            <span className="text-muted">Context Usage</span>
            <span className="text-ink">{contextUsagePercent}</span>
          </div>
        </div>
      )}
    </div>
  );
}
