'use client';

import { useMemo, useReducer, useState } from 'react';
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

type MoveIssueToDoingFormState = {
  preferredDaemonHost: string;
  backendType: string;
};

type MoveIssueToDoingFormAction =
  | { type: 'select-daemon'; daemonHost: string; supportedBackends: string[] }
  | { type: 'select-backend'; backendType: string };

function moveIssueToDoingFormReducer(
  state: MoveIssueToDoingFormState,
  action: MoveIssueToDoingFormAction,
): MoveIssueToDoingFormState {
  switch (action.type) {
    case 'select-daemon':
      return {
        preferredDaemonHost: action.daemonHost,
        backendType: action.supportedBackends.includes(state.backendType)
          ? state.backendType
          : action.supportedBackends[0] ?? '',
      };
    case 'select-backend':
      return {
        ...state,
        backendType: action.backendType,
      };
    default:
      return state;
  }
}

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
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleClose = () => {
    if (isSubmitting) {
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Move Issue To Doing"
      maxWidthClassName="max-w-lg"
    >
      {open ? (
        <MoveIssueToDoingDialogContent
          daemonOptions={daemonOptions}
          initialDaemon={initialDaemon}
          initialBackend={initialBackend}
          onConfirm={onConfirm}
          onClose={onClose}
          isSubmitting={isSubmitting}
          setIsSubmitting={setIsSubmitting}
        />
      ) : null}
    </Dialog>
  );
}

function MoveIssueToDoingDialogContent({
  daemonOptions,
  initialDaemon,
  initialBackend,
  onClose,
  onConfirm,
  isSubmitting,
  setIsSubmitting,
}: {
  daemonOptions: MoveIssueToDoingDaemonOption[];
  initialDaemon?: string | null;
  initialBackend?: string | null;
  onClose: () => void;
  onConfirm: (args: MoveIssueToDoingConfirm) => Promise<void> | void;
  isSubmitting: boolean;
  setIsSubmitting: React.Dispatch<React.SetStateAction<boolean>>;
}) {
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
  // Only show the daemon row when there is an actual choice to make — i.e.
  // a merged-group / multi-daemon-default project with 2+ daemons online
  // right now. For single-daemon projects (or multi-daemon scenarios where
  // only one daemon is currently online) the daemon is implicit and the
  // picker would just be noise. The IssueCard's daemon tag carries the
  // "which machine ran this" attribution after the fact instead.
  const showDaemonPicker = orderedHosts.length > 1;

  const normalizedInitialDaemon = normalizeString(initialDaemon);
  const initialIsOnline = normalizedInitialDaemon
    ? optionByHost.has(normalizedInitialDaemon)
    : false;
  const initialDaemonHost = initialIsOnline
    ? normalizedInitialDaemon
    : orderedHosts[0] ?? '';
  const normalizedInitialBackend = normalizeString(initialBackend);
  const initialBackends = optionByHost.get(initialDaemonHost)?.supportedBackends ?? [];
  const initialBackendType = normalizedInitialBackend && initialBackends.includes(normalizedInitialBackend)
    ? normalizedInitialBackend
    : initialBackends[0] ?? '';
  const offlineFallbackHost = normalizedInitialDaemon && !initialIsOnline ? normalizedInitialDaemon : null;

  const [state, dispatch] = useReducer(moveIssueToDoingFormReducer, {
    preferredDaemonHost: initialDaemonHost,
    backendType: initialBackendType,
  });

  const daemonHost = optionByHost.has(state.preferredDaemonHost)
    ? state.preferredDaemonHost
    : initialDaemonHost;
  const currentOption = optionByHost.get(daemonHost) ?? null;
  const availableBackends = currentOption?.supportedBackends ?? [];
  const backendType = availableBackends.includes(state.backendType)
    ? state.backendType
    : availableBackends[0] ?? '';

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
    <div className="space-y-5">
      {offlineFallbackHost ? (
        <p
          role="status"
          className="rounded-md border border-amber-400/50 bg-amber-50/50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200"
        >
          Last daemon <code>{offlineFallbackHost}</code> is offline, defaulting to{' '}
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
            onChange={(event) => dispatch({
              type: 'select-daemon',
              daemonHost: event.target.value,
              supportedBackends: optionByHost.get(event.target.value)?.supportedBackends ?? [],
            })}
            className="w-full webapp-input"
            disabled={isSubmitting}
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
          onChange={(event) => dispatch({ type: 'select-backend', backendType: event.target.value })}
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
          onClick={onClose}
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
  );
}
