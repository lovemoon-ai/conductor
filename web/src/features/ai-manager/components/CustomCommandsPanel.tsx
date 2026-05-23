'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { SectionCard } from '@/components/common/SectionCard';
import { useToast } from '@/components/common/FeedbackProvider';
import { getApiClient } from '@/shared/api/client';
import type {
  CustomCommandInfo,
  CustomCommandRunResponse,
  CustomCommandRunStatus,
  CustomCommandRunStatusValue,
  CustomCommandsResponse,
} from '../types';

interface CustomCommandsPanelProps {
  agentHost: string;
  supported: boolean;
}

type CommandRunView = {
  runId: string;
  key: string;
  status: CustomCommandRunStatusValue;
  pid?: number | null;
  exitCode?: number | null;
  signal?: string | null;
  stdoutTail?: string;
  stderrTail?: string;
  error?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
};

function normalizeCommands(payload: CustomCommandsResponse): CustomCommandInfo[] {
  if (!payload || !Array.isArray(payload.commands)) return [];
  return payload.commands
    .filter((command) => typeof command.key === 'string' && command.key.trim())
    .map((command) => ({
      key: command.key.trim(),
      running: command.running === true,
      ...(typeof command.runId === 'string' && command.runId ? { runId: command.runId } : {}),
    }));
}

function statusBadge(status: CustomCommandRunStatusValue) {
  const className =
    status === 'completed'
      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : status === 'failed'
        ? 'bg-[var(--error)]/10 text-[var(--error)]'
        : 'bg-amber-500/10 text-amber-700 dark:text-amber-300';
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${className}`}>
      {status}
    </span>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function CustomCommandsPanel({ agentHost, supported }: CustomCommandsPanelProps) {
  const { pushToast } = useToast();
  const [commands, setCommands] = useState<CustomCommandInfo[]>([]);
  const [runsByKey, setRunsByKey] = useState<Record<string, CommandRunView>>({});
  const [runningKeys, setRunningKeys] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCommands([]);
    setRunsByKey({});
    setRunningKeys({});
    setError(null);
    setLoaded(false);
    if (!supported || !agentHost) {
      return;
    }

    let cancelled = false;
    const loadCommands = async () => {
      setLoading(true);
      try {
        const api = getApiClient();
        const payload = await api.get<CustomCommandsResponse>(
          `/agents/${encodeURIComponent(agentHost)}/custom-commands`,
        );
        if (cancelled) return;
        const nextCommands = normalizeCommands(payload);
        setCommands(nextCommands);
        setRunsByKey((prev) => {
          const next = { ...prev };
          for (const command of nextCommands) {
            if (command.running && command.runId && !next[command.key]) {
              next[command.key] = {
                runId: command.runId,
                key: command.key,
                status: 'running',
              };
            }
          }
          return next;
        });
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(err, 'Failed to load custom commands'));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setLoaded(true);
        }
      }
    };

    void loadCommands();
    return () => {
      cancelled = true;
    };
  }, [agentHost, supported]);

  // Snapshot the latest runs in a ref so the poll callback can read them
  // without forcing the effect (and its setInterval) to tear down + restart
  // on every status update. Without this, each successful poll mutates
  // `runsByKey` (stdoutTail etc.), which re-derives `activeRuns`, which
  // re-runs the effect, which immediately polls again — a tight loop instead
  // of a 2s tick.
  const runsByKeyRef = useRef(runsByKey);
  useEffect(() => {
    runsByKeyRef.current = runsByKey;
  }, [runsByKey]);

  // Use a stable identity (the set of running runIds) as the effect dep so
  // the interval is only re-created when the *set* of active runs actually
  // changes — not when the per-run payload (status fields, output tails)
  // changes.
  const activeRunIdsKey = useMemo(() => {
    const ids: string[] = [];
    for (const run of Object.values(runsByKey)) {
      if (run.status === 'running' && run.runId) ids.push(run.runId);
    }
    return ids.sort().join('|');
  }, [runsByKey]);

  useEffect(() => {
    if (!supported || !agentHost || !activeRunIdsKey) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      const api = getApiClient();
      const currentRuns = Object.values(runsByKeyRef.current).filter(
        (run) => run.status === 'running' && run.runId,
      );
      await Promise.all(
        currentRuns.map(async (run) => {
          try {
            const status = await api.get<CustomCommandRunStatus>(
              `/agents/${encodeURIComponent(agentHost)}/custom-commands/runs/${encodeURIComponent(run.runId)}`,
            );
            if (cancelled) return;
            setRunsByKey((prev) => ({
              ...prev,
              [status.key]: { ...prev[status.key], ...status },
            }));
            setCommands((prev) => prev.map((command) => (
              command.key === status.key
                ? { ...command, running: status.status === 'running', runId: status.runId }
                : command
            )));
            if (status.status === 'completed') {
              pushToast({
                title: 'Command completed',
                description: status.key,
                variant: 'success',
              });
            } else if (status.status === 'failed') {
              pushToast({
                title: 'Command failed',
                description: status.error || status.key,
                variant: 'error',
              });
            }
          } catch (err) {
            if (!cancelled) {
              setCommands((prev) => prev.map((command) => (
                command.key === run.key ? { ...command, running: false } : command
              )));
              setRunsByKey((prev) => ({
                ...prev,
                [run.key]: {
                  ...run,
                  status: 'failed',
                  error: errorMessage(err, 'Failed to refresh command status'),
                },
              }));
            }
          }
        }),
      );
    };

    const timer = setInterval(() => {
      void poll();
    }, 2_000);
    void poll();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeRunIdsKey, agentHost, pushToast, supported]);

  const runCommand = async (key: string) => {
    if (!agentHost || runningKeys[key] || runsByKey[key]?.status === 'running') {
      return;
    }
    setRunningKeys((prev) => ({ ...prev, [key]: true }));
    try {
      const api = getApiClient();
      const result = await api.post<CustomCommandRunResponse>(
        `/agents/${encodeURIComponent(agentHost)}/custom-commands/run`,
        { key },
      );
      const nextRun: CommandRunView = {
        ...result,
        status: result.status || 'running',
      };
      setRunsByKey((prev) => ({ ...prev, [key]: nextRun }));
      setCommands((prev) => prev.map((command) => (
        command.key === key
          ? { ...command, running: nextRun.status === 'running', runId: nextRun.runId }
          : command
      )));
      pushToast({
        title: 'Command started',
        description: key,
        variant: 'success',
      });
    } catch (err) {
      pushToast({
        title: 'Failed to run command',
        description: errorMessage(err, 'Failed to run command'),
        variant: 'error',
      });
    } finally {
      setRunningKeys((prev) => ({ ...prev, [key]: false }));
    }
  };

  if (!supported) {
    return null;
  }
  if (loaded && commands.length === 0 && !error) {
    return null;
  }

  return (
    <SectionCard title="Custom Commands">
      {loading && !loaded ? (
        <p className="text-sm text-muted">Loading custom commands...</p>
      ) : commands.length > 0 ? (
        <div className="flex flex-col divide-y divide-border">
          {commands.map((command) => {
            const run = runsByKey[command.key];
            const isRunning = runningKeys[command.key] || command.running || run?.status === 'running';
            const canRun = !isRunning;
            const output = [run?.stdoutTail, run?.stderrTail].filter(Boolean).join('\n');

            return (
              <div key={command.key} className="min-w-0 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="break-all font-mono text-sm font-semibold text-ink">
                      {command.key}
                    </span>
                    {run ? statusBadge(run.status) : null}
                    {run?.exitCode !== undefined && run.exitCode !== null ? (
                      <span className="text-xs text-muted">exit {run.exitCode}</span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => void runCommand(command.key)}
                    disabled={!canRun}
                    aria-label={`Run custom command ${command.key}`}
                    className="webapp-btn-primary inline-flex items-center justify-center px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isRunning ? 'Running...' : 'Run'}
                  </button>
                </div>

                {run?.error ? (
                  <p className="mt-2 text-xs text-[var(--error)]">{run.error}</p>
                ) : null}
                {output ? (
                  <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-paper p-3 font-mono text-xs text-ink">
                    {output}
                  </pre>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted">No custom commands configured on this daemon.</p>
      )}
      {error ? <p className="mt-2 text-xs text-[var(--error)]">{error}</p> : null}
    </SectionCard>
  );
}
