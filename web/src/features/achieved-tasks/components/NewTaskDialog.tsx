'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Dialog } from '@/components/common/Dialog';
import { getCompatibleRestartBackends } from '@/lib/tasks/restart';
import type { AchievedTaskSummary } from '@/shared/types';
import type { DaemonCandidate } from './DaemonPickerDialog';

interface NewTaskDialogProps {
  task: AchievedTaskSummary | null;
  candidates: DaemonCandidate[];
  busy: boolean;
  onCreate: (host: string, backend: string) => void;
  onClose: () => void;
}

const backendsFor = (
  candidate: DaemonCandidate | undefined,
  sourceBackend: string,
): string[] =>
  getCompatibleRestartBackends(
    sourceBackend,
    Array.isArray(candidate?.supportedBackends) ? candidate.supportedBackends : [],
  );

export function NewTaskDialog({
  task,
  candidates,
  busy,
  onCreate,
  onClose,
}: NewTaskDialogProps) {
  const [selectedHost, setSelectedHost] = useState('');
  const [selectedBackend, setSelectedBackend] = useState('');
  const sourceBackend = task?.backendType?.trim() ?? '';

  useEffect(() => {
    if (!task) {
      setSelectedHost('');
      setSelectedBackend('');
      return;
    }

    const originalCandidate = candidates.find(
      (candidate) => candidate.host === (task.daemonHost ?? task.agentHost),
    );
    const defaultCandidate =
      (originalCandidate && backendsFor(originalCandidate, sourceBackend).length > 0
        ? originalCandidate
        : null) ??
      candidates.find((candidate) =>
        backendsFor(candidate, sourceBackend).includes(sourceBackend),
      ) ??
      candidates.find((candidate) => backendsFor(candidate, sourceBackend).length > 0);
    const defaultBackends = backendsFor(defaultCandidate, sourceBackend);
    setSelectedHost(defaultCandidate?.host ?? '');
    setSelectedBackend(
      defaultBackends.includes(sourceBackend) ? sourceBackend : (defaultBackends[0] ?? ''),
    );
  }, [candidates, sourceBackend, task]);

  const selectedCandidate = useMemo(
    () => candidates.find((candidate) => candidate.host === selectedHost),
    [candidates, selectedHost],
  );
  const backendOptions = useMemo(
    () => backendsFor(selectedCandidate, sourceBackend),
    [selectedCandidate, sourceBackend],
  );

  const handleDaemonChange = (host: string) => {
    const candidate = candidates.find((entry) => entry.host === host);
    const nextBackends = backendsFor(candidate, sourceBackend);
    setSelectedHost(host);
    setSelectedBackend(
      nextBackends.includes(sourceBackend) ? sourceBackend : (nextBackends[0] ?? ''),
    );
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedHost || !selectedBackend || busy) return;
    onCreate(selectedHost, selectedBackend);
  };

  return (
    <Dialog
      open={task !== null}
      onClose={onClose}
      title="New task"
      description="Choose where and how to continue this archived conversation."
      maxWidthClassName="max-w-lg"
    >
      {candidates.length === 0 ? (
        <div className="py-4 text-center text-sm text-muted">
          No connected daemons are available to host this task.
        </div>
      ) : (
        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <label htmlFor="achieved-new-task-daemon" className="text-sm font-medium text-ink">
              Daemon
            </label>
            <select
              id="achieved-new-task-daemon"
              value={selectedHost}
              onChange={(event) => handleDaemonChange(event.target.value)}
              disabled={busy}
              className="webapp-input h-10 w-full"
            >
              {candidates.map((candidate) => (
                <option key={candidate.host} value={candidate.host}>
                  {candidate.host}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label htmlFor="achieved-new-task-backend" className="text-sm font-medium text-ink">
              Backend
            </label>
            <select
              id="achieved-new-task-backend"
              value={selectedBackend}
              onChange={(event) => setSelectedBackend(event.target.value)}
              disabled={busy || backendOptions.length === 0}
              className="webapp-input h-10 w-full"
            >
              {backendOptions.map((backend) => (
                <option key={backend} value={backend}>
                  {backend}
                </option>
              ))}
            </select>
            {backendOptions.length === 0 ? (
              <p className="text-sm text-error">
                This daemon does not advertise a compatible backend.
              </p>
            ) : null}
          </div>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="h-10 rounded-xl border border-border px-4 text-sm font-medium text-muted transition-colors hover:bg-paper hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !selectedHost || !selectedBackend}
              className="webapp-btn-primary h-10 rounded-xl px-4 text-sm disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? 'Creating...' : 'New'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
