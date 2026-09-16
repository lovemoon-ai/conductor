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
  /**
   * RFC 0038: other options' hosts that can hold the git worktree of a task
   * whose AI runs on this one (online with remote_exec + remote_file, a
   * git-backed project the API treats as the same project as this option's).
   */
  remoteWorktreeHosts?: string[];
};

export type MoveIssueToDoingConfirm = {
  backendType: string;
  daemonHost: string;
  projectId: string;
  /** Daemon hosting the worktree; omitted when it is the AI's own daemon. */
  remoteWorktreeHost?: string;
};

const normalizeString = (value: string | null | undefined): string =>
  typeof value === 'string' ? value.trim() : '';

type MoveIssueToDoingFormState = {
  preferredDaemonHost: string;
  backendType: string;
  remoteWorktreeHost: string;
};

type MoveIssueToDoingFormAction =
  | { type: 'select-daemon'; daemonHost: string; supportedBackends: string[] }
  | { type: 'select-backend'; backendType: string }
  | { type: 'select-remote-worktree'; remoteWorktreeHost: string };

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
        // The AI daemon changed; the worktree host may now be that daemon.
        remoteWorktreeHost: '',
      };
    case 'select-backend':
      return {
        ...state,
        backendType: action.backendType,
      };
    case 'select-remote-worktree':
      return {
        ...state,
        remoteWorktreeHost: action.remoteWorktreeHost,
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
    remoteWorktreeHost: '',
  });

  const daemonHost = optionByHost.has(state.preferredDaemonHost)
    ? state.preferredDaemonHost
    : initialDaemonHost;
  const currentOption = optionByHost.get(daemonHost) ?? null;
  const availableBackends = currentOption?.supportedBackends ?? [];
  const backendType = availableBackends.includes(state.backendType)
    ? state.backendType
    : availableBackends[0] ?? '';
  // Other online daemons that can host this task's worktree while the AI runs
  // on `daemonHost`.
  const remoteWorktreeHosts = (currentOption?.remoteWorktreeHosts ?? [])
    .filter((host) => host !== daemonHost && optionByHost.has(host));
  const remoteWorktreeHost = state.remoteWorktreeHost;
  // Keep a vanished pick (daemon went offline while the dialog was open) and
  // block confirm, instead of quietly falling back to a local worktree.
  const remoteWorktreeHostUnavailable = Boolean(remoteWorktreeHost)
    && !remoteWorktreeHosts.includes(remoteWorktreeHost);

  const handleConfirm = async () => {
    if (!backendType || !currentOption || isSubmitting || remoteWorktreeHostUnavailable) {
      return;
    }
    setIsSubmitting(true);
    try {
      await onConfirm({
        backendType,
        daemonHost: currentOption.host,
        projectId: currentOption.projectId,
        ...(remoteWorktreeHost ? { remoteWorktreeHost } : {}),
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

      {remoteWorktreeHostUnavailable ? (
        <p
          role="alert"
          className="rounded-md border border-amber-400/50 bg-amber-50/50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200"
        >
          {remoteWorktreeHost === daemonHost ? (
            // The picked AI daemon went offline and the AI fell back onto the
            // daemon chosen as the workspace.
            <>
              Daemon <code>{state.preferredDaemonHost}</code> went offline, so the AI now runs on{' '}
              <code>{daemonHost}</code>, your chosen workspace.
            </>
          ) : (
            <>Workspace daemon <code>{remoteWorktreeHost}</code> is no longer available.</>
          )}{' '}
          Pick another workspace to continue.
        </p>
      ) : null}

      {remoteWorktreeHosts.length > 0 || remoteWorktreeHostUnavailable ? (
        <details className="rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-ink">
            Workspace on another daemon{remoteWorktreeHost ? `: ${remoteWorktreeHost}` : ''}
          </summary>
          <select
            id="issue-doing-remote-worktree"
            aria-label="Workspace on another daemon"
            value={remoteWorktreeHost}
            onChange={(event) => dispatch({
              type: 'select-remote-worktree',
              remoteWorktreeHost: event.target.value,
            })}
            className="mt-2 w-full webapp-input"
            disabled={isSubmitting}
          >
            <option value="">Same daemon as the AI (default)</option>
            {remoteWorktreeHostUnavailable ? (
              <option value={remoteWorktreeHost} disabled>
                {remoteWorktreeHost} (unavailable)
              </option>
            ) : null}
            {remoteWorktreeHosts.map((host) => {
              const option = optionByHost.get(host);
              return (
                <option key={host} value={host}>
                  {option?.label?.trim() ? option.label : host}
                </option>
              );
            })}
          </select>
          <p className="mt-1 text-xs text-muted">
            Run the AI on {daemonHost} but create the git worktree, build and test on the chosen daemon.
          </p>
        </details>
      ) : null}

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
          disabled={!backendType || !currentOption || isSubmitting || remoteWorktreeHostUnavailable}
          className="webapp-btn-primary px-5 py-2.5 text-sm"
        >
          {isSubmitting ? 'Starting...' : 'Move To Doing'}
        </button>
      </div>
    </div>
  );
}
