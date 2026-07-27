'use client';

import { Dialog } from '@/components/common/Dialog';

export interface DaemonCandidate {
  host: string;
  supportedBackends?: string[];
}

interface DaemonPickerDialogProps {
  open: boolean;
  title: string;
  description?: string;
  candidates: DaemonCandidate[];
  busyHost?: string | null;
  onPick: (host: string) => void;
  onClose: () => void;
}

export function DaemonPickerDialog({
  open,
  title,
  description,
  candidates,
  busyHost,
  onPick,
  onClose,
}: DaemonPickerDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description}>
      {candidates.length === 0 ? (
        <div className="py-4 text-center text-sm text-muted">
          No connected daemons are available to host this task.
        </div>
      ) : (
        <ul className="space-y-2">
          {candidates.map((candidate) => {
            const isBusy = busyHost === candidate.host;
            const disabled = Boolean(busyHost);
            return (
              <li key={candidate.host}>
                <button
                  type="button"
                  onClick={() => onPick(candidate.host)}
                  disabled={disabled}
                  className="flex w-full items-center gap-3 rounded-lg border border-border bg-paper px-3 py-3 text-left transition-colors hover:border-[var(--accent)]/40 hover:bg-[var(--accent)]/5 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="size-2 shrink-0 rounded-full bg-success" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{candidate.host}</p>
                    {candidate.supportedBackends && candidate.supportedBackends.length > 0 ? (
                      <p className="truncate text-xs text-muted">
                        {candidate.supportedBackends.join(', ')}
                      </p>
                    ) : null}
                  </div>
                  {isBusy ? <span className="text-xs text-muted">Working...</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
