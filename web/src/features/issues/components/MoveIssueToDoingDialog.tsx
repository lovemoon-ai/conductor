'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/common/Dialog';

/**
 * One row in the daemon picker. Each option carries the underlying project id
 * because, in a cross-daemon merged group, the issue's `projectId` may need to
 * be re-parented to the sibling that lives on the chosen daemon. The dialog
 * does not know about merged groups itself — the caller bundles the daemon +
 * sibling-project mapping into this list.
 */
export type MoveIssueToDoingDaemonOption = {
  host: string;
  projectId: string;
  /** Optional display label; defaults to `host` when omitted. */
  label?: string;
  /** Backends advertised by the daemon's online agent. */
  supportedBackends: string[];
};

export type MoveIssueToDoingConfirm = {
  backendType: string;
  daemonHost: string;
  projectId: string;
};

const normalizeString = (value: string | null | undefined): string =>
  typeof value === 'string' ? value.trim() : '';

export function MoveIssueToDoingDialog({
  open,
  daemonOptions,
  initialDaemon,
  initialBackend,
  onClose,
  onConfirm,
}: {
  open: boolean;
  daemonOptions: MoveIssueToDoingDaemonOption[];
  initialDaemon?: string | null;
  initialBackend?: string | null;
  onClose: () => void;
  onConfirm: (args: MoveIssueToDoingConfirm) => Promise<void> | void;
}) {
  const [daemonHost, setDaemonHost] = useState('');
  const [backendType, setBackendType] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Set to the requested host when `initialDaemon` was supplied but no option
  // currently matches — typically because that daemon went offline since the
  // last run. We surface this so users notice the dialog quietly fell back.
  const [offlineFallbackHost, setOfflineFallbackHost] = useState<string | null>(null);

  const optionByHost = useMemo(() => {
    const map = new Map<string, MoveIssueToDoingDaemonOption>();
    for (const option of daemonOptions) {
      const host = normalizeString(option.host);
      if (!host || map.has(host)) {
        continue;
      }
      map.set(host, { ...option, host });
    }
    return map;
  }, [daemonOptions]);
  const orderedHosts = useMemo(() => Array.from(optionByHost.keys()), [optionByHost]);
  // Show the daemon row whenever we have at least one candidate, even if it
  // is the only one. The first time an issue enters doing the user explicitly
  // expects to *see* which daemon is going to take it — hiding the row when
  // there happens to be only one online sibling makes the "issue is not bound
  // to a daemon until this dialog" promise invisible. We disable the select
  // when nothing is selectable, so the affordance still telegraphs "this is
  // the daemon the task will spawn on."
  const showDaemonPicker = orderedHosts.length >= 1;
  const daemonPickerDisabled = orderedHosts.length <= 1;

  const currentOption = optionByHost.get(daemonHost) ?? null;
  const availableBackends = useMemo(
    () => currentOption?.supportedBackends ?? [],
    [currentOption],
  );

  useEffect(() => {
    if (!open) {
      setDaemonHost('');
      setBackendType('');
      setIsSubmitting(false);
      setOfflineFallbackHost(null);
      return;
    }

    const normalizedInitialDaemon = normalizeString(initialDaemon);
    const initialIsOnline = normalizedInitialDaemon
      ? optionByHost.has(normalizedInitialDaemon)
      : false;
    const nextDaemonHost = initialIsOnline
      ? normalizedInitialDaemon
      : orderedHosts[0] ?? '';
    setDaemonHost(nextDaemonHost);
    setOfflineFallbackHost(
      normalizedInitialDaemon && !initialIsOnline ? normalizedInitialDaemon : null,
    );

    const nextBackends = optionByHost.get(nextDaemonHost)?.supportedBackends ?? [];
    const normalizedInitialBackend = normalizeString(initialBackend);
    if (normalizedInitialBackend && nextBackends.includes(normalizedInitialBackend)) {
      setBackendType(normalizedInitialBackend);
      return;
    }
    setBackendType(nextBackends[0] ?? '');
  }, [initialBackend, initialDaemon, open, optionByHost, orderedHosts]);

  // When the daemon changes mid-dialog (multi-daemon merged group), make sure
  // we keep showing a backend the newly selected daemon actually supports.
  useEffect(() => {
    if (!open) {
      return;
    }
    if (availableBackends.length === 0) {
      if (backendType !== '') {
        setBackendType('');
      }
      return;
    }
    if (!backendType || !availableBackends.includes(backendType)) {
      setBackendType(availableBackends[0]);
    }
  }, [availableBackends, backendType, open]);

  const handleClose = () => {
    if (isSubmitting) {
      return;
    }
    onClose();
  };

  const handleConfirm = async () => {
    if (!backendType || !currentOption || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    try {
      await onConfirm({
        backendType,
        daemonHost: currentOption.host,
        projectId: currentOption.projectId,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Move Issue To Doing"
      maxWidthClassName="max-w-lg"
    >
      <div className="space-y-5">
        {offlineFallbackHost ? (
          <p
            role="status"
            className="rounded-md border border-amber-400/50 bg-amber-50/50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200"
          >
            Last daemon <code>{offlineFallbackHost}</code> is offline — defaulting to{' '}
            <code>{currentOption?.host ?? '—'}</code>.
          </p>
        ) : null}

        {showDaemonPicker ? (
          <div>
            <label htmlFor="issue-doing-daemon" className="mb-2 block text-sm font-medium text-ink">
              Daemon
            </label>
            <select
              id="issue-doing-daemon"
              value={daemonHost}
              onChange={(event) => setDaemonHost(event.target.value)}
              className="w-full webapp-input"
              disabled={isSubmitting || daemonPickerDisabled}
            >
              {orderedHosts.map((host) => {
                const option = optionByHost.get(host);
                return (
                  <option key={host} value={host}>
                    {option?.label?.trim() ? option.label : host}
                  </option>
                );
              })}
            </select>
          </div>
        ) : null}

        <div>
          <label htmlFor="issue-doing-backend" className="mb-2 block text-sm font-medium text-ink">
            Backend
          </label>
          <select
            id="issue-doing-backend"
            value={backendType}
            onChange={(event) => setBackendType(event.target.value)}
            className="w-full webapp-input"
            disabled={isSubmitting || availableBackends.length === 0}
          >
            {availableBackends.map((backend) => (
              <option key={backend} value={backend}>
                {backend}
              </option>
            ))}
          </select>
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg px-4 py-2.5 text-sm text-muted transition-colors hover:bg-border/30 hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!backendType || !currentOption || isSubmitting}
            className="webapp-btn-primary px-5 py-2.5 text-sm"
          >
            {isSubmitting ? 'Starting...' : 'Move To Doing'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
