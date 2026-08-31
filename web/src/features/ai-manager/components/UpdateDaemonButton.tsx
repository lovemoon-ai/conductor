'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfirm, useToast } from '@/components/common/FeedbackProvider';
import { getApiClient } from '@/shared/api/client';
import type { DaemonUpdateStatus } from '../types';

interface UpdateDaemonButtonProps {
  agentHost: string;
  supported: boolean;
  /** Called once an update finishes so the panel can re-read the daemon version. */
  onFinished?: () => void;
}

const POLL_INTERVAL_MS = 2_000;
/** Install + verify + restart; generous enough for a slow registry, then give up. */
const POLL_TIMEOUT_MS = 15 * 60_000;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * The daemon restarts itself midway through a successful update, so polling has
 * to tolerate the request failing for a while: a failed poll means "daemon is
 * not answering right now", not "the update failed". Only the status file the
 * detached updater writes is authoritative.
 */
export function UpdateDaemonButton({ agentHost, supported, onFinished }: UpdateDaemonButtonProps) {
  const { confirm } = useConfirm();
  const { pushToast } = useToast();
  const [status, setStatus] = useState<DaemonUpdateStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [offline, setOffline] = useState(false);
  const onFinishedRef = useRef(onFinished);

  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  const isRunning = polling || status?.status === 'running';

  const readStatus = useCallback(async () => {
    const api = getApiClient();
    return api.get<DaemonUpdateStatus>(`/agents/${encodeURIComponent(agentHost)}/update`);
  }, [agentHost]);

  // Surface an update that is already in flight (or the last one's outcome)
  // when the panel mounts or the selected daemon changes.
  useEffect(() => {
    if (!agentHost || !supported) return;
    let cancelled = false;
    void readStatus()
      .then((result) => {
        if (cancelled) return;
        setStatus(result);
        if (result.status === 'running') setPolling(true);
      })
      .catch(() => {
        /* nothing to show yet */
      });
    return () => {
      cancelled = true;
    };
  }, [agentHost, supported, readStatus]);

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    const finish = (result: DaemonUpdateStatus) => {
      setPolling(false);
      setOffline(false);
      pushToast(
        result.status === 'completed'
          ? {
              title: 'Daemon updated',
              description: result.message || agentHost,
              variant: 'success',
            }
          : {
              title: 'Daemon update failed',
              description: result.error || result.message || agentHost,
              variant: 'error',
            },
      );
      onFinishedRef.current?.();
    };

    const poll = async () => {
      try {
        const result = await readStatus();
        if (cancelled) return;
        setOffline(false);
        setStatus(result);
        if (result.status !== 'running') finish(result);
      } catch {
        if (cancelled) return;
        // Expected while the daemon is being restarted onto the new version.
        setOffline(true);
        if (Date.now() > deadline) {
          setPolling(false);
          pushToast({
            title: 'Lost track of the daemon update',
            description: `${agentHost} stopped answering. Check the update log on that machine.`,
            variant: 'error',
          });
        }
      }
    };

    const timer = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    void poll();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [polling, readStatus, agentHost, pushToast]);

  const handleUpdate = async () => {
    if (!agentHost || !supported || starting || isRunning) return;

    const accepted = await confirm({
      title: `Update daemon on ${agentHost}?`,
      description:
        'Installs the latest conductor CLI and restarts the daemon onto it. The daemon is only restarted after the new version installs and verifies, so a failed update leaves the current daemon running. Running tasks will be interrupted on a successful update.',
      confirmLabel: 'Update',
      tone: 'danger',
    });
    if (!accepted) return;

    setStarting(true);
    try {
      const api = getApiClient();
      const result = await api.post<DaemonUpdateStatus>(
        `/agents/${encodeURIComponent(agentHost)}/update`,
        {},
      );
      setStatus(result);
      setPolling(true);
      pushToast({
        title: 'Update started',
        description: `${agentHost} is installing the latest CLI.`,
        variant: 'success',
      });
    } catch (error) {
      pushToast({
        title: 'Failed to start update',
        description: errorMessage(error, 'Failed to start update'),
        variant: 'error',
      });
    } finally {
      setStarting(false);
    }
  };

  if (!supported) return null;

  const detail = offline && isRunning ? 'Restarting daemon…' : status?.message;

  return (
    <div className="flex min-w-0 flex-col items-end gap-2">
      <button
        type="button"
        onClick={() => void handleUpdate()}
        disabled={starting || isRunning}
        aria-label={`Update daemon on ${agentHost}`}
        className="webapp-btn-primary inline-flex items-center justify-center px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
      >
        {starting || isRunning ? 'Updating...' : 'Update daemon'}
      </button>
      {detail ? (
        <p
          className={`max-w-full break-words text-right text-xs ${
            status?.status === 'failed' ? 'text-[var(--error)]' : 'text-muted'
          }`}
        >
          {detail}
        </p>
      ) : null}
      {status?.status === 'failed' && status.error ? (
        <p className="max-w-full break-words text-right text-xs text-[var(--error)]">
          {status.error}
        </p>
      ) : null}
    </div>
  );
}
