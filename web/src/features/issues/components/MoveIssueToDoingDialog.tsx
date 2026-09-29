'use client';

import { useMemo, useReducer, useState } from 'react';
import { Dialog } from '@/components/common/Dialog';
import {
  AgentGroupPicker,
  buildAgentGroupRequest,
  reduceAgentGroup,
  useProjectAgentRegistry,
  type AgentGroupAction,
  type AgentGroupSelection,
} from '@/features/tasks/components/AgentGroupPicker';
import type { CreateTaskInput } from '@/shared/types';

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
  /**
   * RFC 0041: global AI backends that can run this option's task while the
   * code stays on its daemon; `disabledReason` greys out one that cannot now.
   */
  globalBackends?: MoveIssueToDoingGlobalBackendOption[];
};

export type MoveIssueToDoingGlobalBackendOption = {
  host: string;
  backend: string;
  disabledReason: string | null;
};

const globalBackendValue = (entry: { host: string; backend: string }): string =>
  `global:${entry.host}\u0000${entry.backend}`;

export type MoveIssueToDoingConfirm = {
  backendType: string;
  daemonHost: string;
  projectId: string;
  /** Daemon hosting the worktree; omitted when it is the AI's own daemon. */
  remoteWorktreeHost?: string;
  /** RFC 0033: worker + reviewer agents; omitted for a plain task. */
  agents?: CreateTaskInput['agents'];
  /** RFC 0041: run the AI on this global backend; `backendType` is its backend. */
  globalBackend?: { host: string; backend: string };
};

const normalizeString = (value: string | null | undefined): string =>
  typeof value === 'string' ? value.trim() : '';

type MoveIssueToDoingFormState = AgentGroupSelection & {
  preferredDaemonHost: string;
  backendType: string;
  remoteWorktreeHost: string;
  /** `globalBackendValue` of the picked global backend, or empty. */
  globalBackend: string;
};

type MoveIssueToDoingFormAction =
  | { type: 'select-daemon'; daemonHost: string; supportedBackends: string[] }
  | { type: 'select-backend'; backendType: string }
  | { type: 'select-global-backend'; globalBackend: string }
  | { type: 'select-remote-worktree'; remoteWorktreeHost: string }
  | AgentGroupAction;

function moveIssueToDoingFormReducer(
  state: MoveIssueToDoingFormState,
  action: MoveIssueToDoingFormAction,
): MoveIssueToDoingFormState {
  switch (action.type) {
    case 'select-daemon':
      return {
        ...state,
        preferredDaemonHost: action.daemonHost,
        backendType: action.supportedBackends.includes(state.backendType)
          ? state.backendType
          : action.supportedBackends[0] ?? '',
        // The AI daemon changed; the worktree host may now be that daemon.
        remoteWorktreeHost: '',
        globalBackend: '',
      };
    case 'select-backend':
      return {
        ...state,
        backendType: action.backendType,
        globalBackend: '',
      };
    // A global backend runs the AI elsewhere: no remote worktree or agent group.
    case 'select-global-backend':
      return {
        ...state,
        globalBackend: action.globalBackend,
        remoteWorktreeHost: '',
        workerAgent: '',
        reviewers: [],
      };
    case 'select-remote-worktree':
      return {
        ...state,
        remoteWorktreeHost: action.remoteWorktreeHost,
      };
    default:
      return reduceAgentGroup(state, action);
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
    globalBackend: '',
    workerAgent: '',
    reviewers: [],
  });
  // The agent registry is fetched from the daemon, so only once the user opens
  // the optional Agents section.
  const [agentsSectionOpened, setAgentsSectionOpened] = useState(false);

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
  const globalBackendOptions = currentOption?.globalBackends ?? [];
  const selectedGlobalBackend = globalBackendOptions.find(
    (option) => globalBackendValue(option) === state.globalBackend && !option.disabledReason,
  ) ?? null;
  const { availableAgents, isLoadingAgents, agentsLoadFailed } = useProjectAgentRegistry(
    agentsSectionOpened ? currentOption?.projectId ?? null : null,
    dispatch,
  );
  const agents = buildAgentGroupRequest(state);
  // After a daemon switch the picked agents are not yet validated against the
  // new project's registry; never submit a group the user can no longer see.
  const agentsPending = Boolean(agents) && (isLoadingAgents || agentsLoadFailed);
  // The API rejects a remote worktree for agent groups; the pick is kept and
  // comes back if the worker agent is cleared.
  const remoteWorktreeHost = agents ? '' : state.remoteWorktreeHost;
  // Keep a vanished pick (daemon went offline while the dialog was open) and
  // block confirm, instead of quietly falling back to a local worktree.
  const remoteWorktreeHostUnavailable = Boolean(remoteWorktreeHost)
    && !remoteWorktreeHosts.includes(remoteWorktreeHost);

  const effectiveBackendType = selectedGlobalBackend?.backend ?? backendType;

  const handleConfirm = async () => {
    if (!effectiveBackendType || !currentOption || isSubmitting || remoteWorktreeHostUnavailable || agentsPending) {
      return;
    }
    setIsSubmitting(true);
    try {
      await onConfirm({
        backendType: effectiveBackendType,
        daemonHost: currentOption.host,
        projectId: currentOption.projectId,
        ...(selectedGlobalBackend
          ? { globalBackend: { host: selectedGlobalBackend.host, backend: selectedGlobalBackend.backend } }
          : {}),
        ...(remoteWorktreeHost ? { remoteWorktreeHost } : {}),
        ...(agents ? { agents } : {}),
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
          value={selectedGlobalBackend ? globalBackendValue(selectedGlobalBackend) : backendType}
          onChange={(event) => {
            const { value } = event.target;
            dispatch(value.startsWith('global:')
              ? { type: 'select-global-backend', globalBackend: value }
              : { type: 'select-backend', backendType: value });
          }}
          className="w-full webapp-input"
          disabled={isSubmitting || (availableBackends.length === 0 && globalBackendOptions.length === 0)}
        >
          {availableBackends.length === 0 && !selectedGlobalBackend ? (
            <option value="" disabled>Select a backend</option>
          ) : null}
          {availableBackends.map((backend) => (
            <option key={backend} value={backend}>
              {backend}
            </option>
          ))}
          {globalBackendOptions.length > 0 ? (
            <optgroup label="Global">
              {globalBackendOptions.map((option) => {
                const label = `${option.backend} @ ${option.host}`;
                return (
                  <option
                    key={globalBackendValue(option)}
                    value={globalBackendValue(option)}
                    disabled={Boolean(option.disabledReason)}
                    title={option.disabledReason ?? undefined}
                  >
                    {option.disabledReason ? `${label} — ${option.disabledReason}` : label}
                  </option>
                );
              })}
            </optgroup>
          ) : null}
        </select>
        {selectedGlobalBackend ? (
          <p className="mt-1 text-xs text-muted">
            AI runs on {selectedGlobalBackend.host} and works on {daemonHost} through conductor remote.
          </p>
        ) : null}
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

      {!selectedGlobalBackend && (remoteWorktreeHosts.length > 0 || remoteWorktreeHostUnavailable) ? (
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
            disabled={isSubmitting || Boolean(agents)}
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
            {agents
              ? 'Not available together with an agent group.'
              : `Run the AI on ${daemonHost} but create the git worktree, build and test on the chosen daemon.`}
          </p>
        </details>
      ) : null}

      {currentOption && !selectedGlobalBackend ? (
        <details
          className="rounded-lg border border-border px-3 py-2"
          onToggle={(event) => {
            if (event.currentTarget.open) setAgentsSectionOpened(true);
          }}
        >
          <summary className="cursor-pointer text-sm font-medium text-ink">
            Agents{agents ? `: ${agents.map((agent) => agent.name).join(', ')}` : ' (optional)'}
          </summary>
          <p className="mb-2 mt-1 text-xs text-muted">
            Run this issue with a worker agent, plus optional reviewer agents that review it.
          </p>
          {agentsSectionOpened ? (
            <AgentGroupPicker
              id="issue-doing-worker-agent"
              availableAgents={availableAgents}
              isLoadingAgents={isLoadingAgents}
              agentsLoadFailed={agentsLoadFailed}
              availableBackends={availableBackends}
              workerAgent={state.workerAgent}
              reviewers={state.reviewers}
              dispatch={dispatch}
              onSelectBackend={(backend) => dispatch({ type: 'select-backend', backendType: backend })}
              disabled={isSubmitting}
            />
          ) : null}
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
          disabled={!effectiveBackendType || !currentOption || isSubmitting || remoteWorktreeHostUnavailable || agentsPending}
          className="webapp-btn-primary px-5 py-2.5 text-sm"
        >
          {isSubmitting ? 'Starting...' : 'Move To Doing'}
        </button>
      </div>
    </div>
  );
}
