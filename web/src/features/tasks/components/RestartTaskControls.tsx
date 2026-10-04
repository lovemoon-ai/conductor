'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { Task } from '@/shared/types';
import { useAgentsStore } from '@/features/agents';
import { useProjectsStore } from '@/features/projects';
import { useTasksStore } from '../store';
import {
  canCreateSuccessorTask,
  getCompatibleRestartBackends,
  RESTART_FIRST_MESSAGE_CAPABILITY,
} from '@/lib/tasks/restart';
import { Dialog } from '@/components/common/Dialog';
import { useToast } from '@/components/common/FeedbackProvider';
import {
  globalAiBackendKey,
  useGlobalAiBackendsStore,
  type GlobalAiBackend,
} from '@/features/user-preferences/global-ai-backends';

interface RestartTaskControlsProps {
  task: Task;
  open: boolean;
  onClose: () => void;
  /**
   * Called with the newly created successor task id after a successful
   * new_task restart. When provided, this takes precedence over the internal
   * URL-only navigation so the caller can update local selection state (which
   * otherwise keeps the UI pinned to the source task). Falls back to
   * navigateToTask when absent.
   */
  onCreatedTask?: (taskId: string) => void;
}

const isConductorFireHost = (host: string | null | undefined): boolean =>
  typeof host === 'string' && host.startsWith('conductor-fire-');

const GLOBAL_OPTION_PREFIX = 'global:';
// Advertised by a daemon that can run a global-backend task's AI (RFC 0041).
const GLOBAL_BACKEND_CAPABILITY = 'global_backend_v1';

// A daemon can hold code a global AI works on only if that AI can drive it
// with `conductor remote exec` and `conductor remote cp`. Same predicate as the
// Create task dialog and the API.
const supportsRemoteWorkspace = (capabilities: string[] | undefined): boolean =>
  Array.isArray(capabilities)
  && ['remote_exec', 'remote_file'].every((required) =>
    capabilities.some((capability) => capability.trim().toLowerCase() === required));

const readRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === 'string') {
    try {
      return readRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
};

/** Host of the source's remote worktree / workspace (RFC 0038 / 0041), if its code lives on another daemon. */
const readRemoteCodeHost = (launchConfig: unknown): string => {
  const config = readRecord(launchConfig);
  for (const key of ['remoteWorktree', 'remote_worktree', 'remoteWorkspace', 'remote_workspace']) {
    const host = readRecord(config?.[key])?.host;
    if (typeof host === 'string' && host.trim()) return host.trim();
  }
  return '';
};

const isRestartableStatus = (status: Task['status']): boolean =>
  status === 'running' || status === 'completed' || status === 'killed' || status === 'unknown';

export function RestartTaskControls({ task, open, onClose, onCreatedTask }: RestartTaskControlsProps) {
  const { push, replace } = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const agents = useAgentsStore((state) => state.agents);
  const projects = useProjectsStore((state) => state.projects);
  const restartTask = useTasksStore((state) => state.restartTask);
  const { pushToast } = useToast();
  const [selectedBackend, setSelectedBackend] = useState('');
  const [selectedDaemonHost, setSelectedDaemonHost] = useState('');
  const [firstMessage, setFirstMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const sourceAgentHost = typeof task.agentHost === 'string' ? task.agentHost.trim() : '';
  const sourceExecutionHost = typeof task.executionHost === 'string' ? task.executionHost.trim() : '';
  const sourceMetadataDaemonHost =
    task.metadata && typeof task.metadata.daemonName === 'string' ? task.metadata.daemonName.trim() : '';
  const sourceProjectDaemonHost = useMemo(() => {
    const projectId = typeof task.projectId === 'string' ? task.projectId.trim() : '';
    if (!projectId) {
      return '';
    }
    const project = projects.find((entry) => entry.id === projectId);
    return project && typeof project.daemonHost === 'string' ? project.daemonHost.trim() : '';
  }, [projects, task.projectId]);
  const currentBackend = typeof task.backendType === 'string' ? task.backendType.trim() : '';
  const isManualFireTask = isConductorFireHost(sourceAgentHost);
  // Daemon candidates that may hold the manual-fire task's workspace, in the
  // same priority order the server uses for auto-resolution.
  const manualFireDaemonCandidates = isManualFireTask
    ? [
        !isConductorFireHost(sourceMetadataDaemonHost) ? sourceMetadataDaemonHost : '',
        sourceExecutionHost && !isConductorFireHost(sourceExecutionHost) ? sourceExecutionHost : '',
        !isConductorFireHost(sourceProjectDaemonHost) ? sourceProjectDaemonHost : '',
      ].filter(Boolean)
    : [];
  const restartSourceHost = isManualFireTask
    ? manualFireDaemonCandidates[0] ?? ''
    : sourceAgentHost;
  // Online daemons the successor can run on. The agents store only lists
  // connected agents; fire connections are not spawn targets.
  const daemonOptions = useMemo(
    () => agents.filter((agent) => !isConductorFireHost(agent.host)).map((agent) => agent.host),
    [agents],
  );
  // Mirror the server's auto-resolution: the host it would pick without an
  // explicit override. A project daemon binding wins over everything (the
  // server forces it); otherwise fire tasks use the first ONLINE candidate
  // and normal tasks reuse the source daemon when it is online. No silent
  // fallback to an arbitrary other machine — when auto-resolution fails, the
  // user must explicitly pick a daemon (the branch then runs on a different
  // machine, which we never do behind their back).
  const projectDaemonCandidate = !isConductorFireHost(sourceProjectDaemonHost)
    ? sourceProjectDaemonHost
    : '';
  const autoResolvedDaemonHost = projectDaemonCandidate
    ? daemonOptions.includes(projectDaemonCandidate)
      ? projectDaemonCandidate
      : ''
    : isManualFireTask
      ? manualFireDaemonCandidates.find((host) => daemonOptions.includes(host)) ?? ''
      : restartSourceHost && daemonOptions.includes(restartSourceHost)
        ? restartSourceHost
        : '';
  // RFC 0041: a global-backend source keeps its code on another daemon (a
  // remote worktree / workspace); its AI ran on `restartSourceHost`.
  const sourceRemoteCodeHost = useMemo(() => readRemoteCodeHost(task.launchConfig), [task.launchConfig]);
  // "Daemon" in this dialog means where the code lives, like the Create task
  // dialog; the Backend dropdown then picks the AI — one of that daemon's own
  // backends, or a global AI on another daemon that works on it remotely.
  const sourceCodeHost = sourceRemoteCodeHost || restartSourceHost;
  const isGlobalBackendSource = Boolean(sourceRemoteCodeHost) && sourceRemoteCodeHost !== restartSourceHost;
  const defaultCodeHost = sourceRemoteCodeHost
    ? (daemonOptions.includes(sourceRemoteCodeHost) ? sourceRemoteCodeHost : '')
    : autoResolvedDaemonHost;
  const effectiveSelectedDaemonHost =
    selectedDaemonHost && daemonOptions.includes(selectedDaemonHost)
      ? selectedDaemonHost
      : defaultCodeHost;
  // Picking a daemon other than the one holding the source task's code moves
  // the work there: its AI runs on it too and starts from its own project copy.
  const isCodeMove = Boolean(effectiveSelectedDaemonHost && effectiveSelectedDaemonHost !== sourceCodeHost);

  const globalBackends = useGlobalAiBackendsStore((state) => state.backends);
  const globalBackendsHydrated = useGlobalAiBackendsStore((state) => state.hydrated);
  const hydrateGlobalBackends = useGlobalAiBackendsStore((state) => state.hydrate);
  useEffect(() => {
    if (open && !globalBackendsHydrated) void hydrateGlobalBackends();
  }, [open, globalBackendsHydrated, hydrateGlobalBackends]);

  // A stale explicit choice must not silently survive a close/reopen.
  useEffect(() => {
    if (open) {
      setSelectedDaemonHost('');
      setSelectedBackend('');
      setFirstMessage('');
    }
  }, [open]);
  const codeAgent = useMemo(
    () => agents.find((agent) => agent.host === effectiveSelectedDaemonHost) ?? null,
    [agents, effectiveSelectedDaemonHost],
  );
  const supportedBackends = useMemo(
    () => (Array.isArray(codeAgent?.supportedBackends) ? codeAgent.supportedBackends : []),
    [codeAgent],
  );
  const backendOptions = useMemo(
    () => getCompatibleRestartBackends(currentBackend, supportedBackends),
    [currentBackend, supportedBackends],
  );
  const currentBackendSupported = currentBackend ? backendOptions.includes(currentBackend) : false;

  // Global AIs from settings, minus the code daemon itself (its backends are
  // already listed). A global-backend source's own AI is always offered so the
  // successor can stay where it was even if settings changed since.
  const globalBackendOptions = useMemo(() => {
    const entries: GlobalAiBackend[] = [...globalBackends];
    if (isGlobalBackendSource && restartSourceHost && currentBackend) {
      const sourceEntry = { host: restartSourceHost, backend: currentBackend };
      if (!entries.some((entry) => globalAiBackendKey(entry) === globalAiBackendKey(sourceEntry))) {
        entries.unshift(sourceEntry);
      }
    }
    return entries
      .filter((entry) => entry.host !== effectiveSelectedDaemonHost && !isConductorFireHost(entry.host))
      .map((entry) => {
        const aiAgent = agents.find((agent) => agent.host === entry.host && !agent.shared) ?? null;
        const aiBackends = Array.isArray(aiAgent?.supportedBackends) ? aiAgent.supportedBackends : [];
        const disabledReason = !effectiveSelectedDaemonHost
          ? 'select a daemon first'
          : isCodeMove
            ? `a global AI continues on the source task's code — pick ${sourceCodeHost || 'its daemon'}`
            : !aiAgent
              ? `${entry.host} is offline`
              : !getCompatibleRestartBackends(currentBackend, aiBackends).includes(entry.backend)
                ? `${entry.backend} is not available on ${entry.host}`
                : !(aiAgent.capabilities ?? []).includes(GLOBAL_BACKEND_CAPABILITY)
                  ? `upgrade conductor on ${entry.host} to use it as a global backend`
                  : !supportsRemoteWorkspace(codeAgent?.capabilities)
                    ? `${effectiveSelectedDaemonHost} does not support conductor remote; upgrade its daemon`
                    : null;
        return {
          value: `${GLOBAL_OPTION_PREFIX}${globalAiBackendKey(entry)}`,
          entry,
          label: `${entry.backend} @ ${entry.host}`,
          disabledReason,
        };
      });
  }, [
    agents,
    codeAgent,
    currentBackend,
    effectiveSelectedDaemonHost,
    globalBackends,
    isCodeMove,
    isGlobalBackendSource,
    restartSourceHost,
    sourceCodeHost,
  ]);
  const enabledGlobalOptions = useMemo(
    () => globalBackendOptions.filter((option) => !option.disabledReason),
    [globalBackendOptions],
  );

  const defaultBackendValue = useMemo(() => {
    // A global-backend source keeps its AI where it ran by default.
    if (isGlobalBackendSource) {
      const sourceOption = enabledGlobalOptions.find(
        (option) => option.entry.host === restartSourceHost && option.entry.backend === currentBackend,
      );
      if (sourceOption) return sourceOption.value;
    }
    if (currentBackendSupported) {
      return currentBackend;
    }
    if (backendOptions.length > 0) {
      return backendOptions[0] || '';
    }
    return currentBackend;
  }, [
    backendOptions,
    currentBackend,
    currentBackendSupported,
    enabledGlobalOptions,
    isGlobalBackendSource,
    restartSourceHost,
  ]);
  const effectiveBackendValue =
    selectedBackend && (backendOptions.includes(selectedBackend)
      || enabledGlobalOptions.some((option) => option.value === selectedBackend))
      ? selectedBackend
      : defaultBackendValue;
  const selectedGlobalBackend =
    enabledGlobalOptions.find((option) => option.value === effectiveBackendValue) ?? null;
  const effectiveSelectedBackend = selectedGlobalBackend ? selectedGlobalBackend.entry.backend : effectiveBackendValue;
  // The daemon the successor's AI runs on.
  const aiHost = selectedGlobalBackend ? selectedGlobalBackend.entry.host : effectiveSelectedDaemonHost;
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.host === aiHost) ?? null,
    [agents, aiHost],
  );
  // Older daemons ignore a custom first message, so the field is only live for
  // daemons that advertise it; the server rejects it otherwise.
  const supportsFirstMessage = Boolean(selectedAgent?.capabilities?.includes(RESTART_FIRST_MESSAGE_CAPABILITY));
  const effectiveFirstMessage = supportsFirstMessage ? firstMessage.trim() : '';

  const disabledReason = useMemo(() => {
    if ((task.taskType ?? 'ai_task') !== 'ai_task') {
      return 'Only AI tasks support restart';
    }
    if (!currentBackend) {
      return 'Missing backend binding';
    }
    if (!task.sessionId) {
      return 'Missing session binding';
    }
    if (!sourceAgentHost) {
      return 'Missing source daemon binding';
    }
    if (!isRestartableStatus(task.status)) {
      return 'Only running or stopped tasks can restart';
    }
    // Note: Fire tasks can always create new tasks; in-place restart is handled by the backend based on strategy
    if (daemonOptions.length === 0) {
      return 'No daemon online';
    }
    if (!codeAgent) {
      if (sourceRemoteCodeHost && !daemonOptions.includes(sourceRemoteCodeHost)) {
        return `Code daemon ${sourceRemoteCodeHost} is offline — select a daemon for the new task`;
      }
      if (projectDaemonCandidate && !daemonOptions.includes(projectDaemonCandidate)) {
        return `Project daemon ${projectDaemonCandidate} is offline — select a daemon to run the new task`;
      }
      return restartSourceHost
        ? `Source daemon ${restartSourceHost} is offline — select a daemon to run the new task`
        : 'Select a daemon to run the new task';
    }
    if (backendOptions.length === 0 && enabledGlobalOptions.length === 0) {
      return 'No compatible backend available on the selected daemon';
    }
    if (!effectiveSelectedBackend || !selectedAgent) {
      return 'Select a backend first';
    }
    if (!canCreateSuccessorTask(currentBackend, effectiveSelectedBackend)) {
      return `Creating a new task from ${currentBackend} to ${effectiveSelectedBackend} is not supported`;
    }
    return null;
  }, [
    backendOptions.length,
    codeAgent,
    currentBackend,
    daemonOptions,
    effectiveSelectedBackend,
    enabledGlobalOptions.length,
    projectDaemonCandidate,
    restartSourceHost,
    selectedAgent,
    sourceAgentHost,
    sourceRemoteCodeHost,
    task.sessionId,
    task.status,
    task.taskType,
  ]);

  const navigateToTask = (nextTaskId: string) => {
    if (pathname === '/app/tasks') {
      const nextQuery = new URLSearchParams(searchParams?.toString() ?? '');
      nextQuery.set('taskId', nextTaskId);
      const query = nextQuery.toString();
      replace(query ? `/app/tasks?${query}` : '/app/tasks', { scroll: false });
      return;
    }
    push(`/app/tasks/${nextTaskId}`);
  };

  const handleRestart = async () => {
    if (disabledReason || !effectiveSelectedBackend || isSubmitting) {
      return;
    }

    try {
      setIsSubmitting(true);
      // Omit the explicit override ONLY in the fully-trivial case: the shown
      // daemon is both what the server would auto-resolve AND the machine the
      // source task ran on — full parity with the pre-selector behavior. In
      // every other case send the displayed daemon explicitly, so the server
      // dispatches to exactly what the UI shows, and any target other than
      // the source machine goes through the cross-daemon path-drop guard
      // (making the warning below always truthful).
      const agentHostOverride =
        aiHost &&
        !(
          aiHost === autoResolvedDaemonHost &&
          aiHost === restartSourceHost
        )
          ? aiHost
          : undefined;
      const result = await restartTask(task.id, {
        backendType: effectiveSelectedBackend,
        strategy: 'new_task',
        ...(agentHostOverride ? { agentHost: agentHostOverride } : {}),
        // Only a move needs it: by default the server keeps the source's code.
        ...(isCodeMove ? { codeHost: effectiveSelectedDaemonHost } : {}),
        ...(effectiveFirstMessage ? { firstMessage: effectiveFirstMessage } : {}),
      });
      if (onCreatedTask) {
        onCreatedTask(result.task.id);
      } else {
        navigateToTask(result.task.id);
      }
      onClose();
    } catch (error) {
      pushToast({
        title: 'Failed to restart task',
        description: error instanceof Error ? error.message : 'Please try again in a moment.',
        variant: 'error',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New task from this"
      maxWidthClassName="max-w-lg"
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <label htmlFor={`restart-daemon-${task.id}`} className="text-sm font-medium text-ink">
            Daemon
          </label>
          <select
            id={`restart-daemon-${task.id}`}
            value={effectiveSelectedDaemonHost}
            onChange={(event) => setSelectedDaemonHost(event.target.value)}
            disabled={daemonOptions.length === 0 || isSubmitting}
            className="w-full rounded-xl border border-border bg-paper px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60"
          >
            {daemonOptions.length > 0 && !effectiveSelectedDaemonHost ? (
              <option value="" disabled>
                Select a daemon…
              </option>
            ) : null}
            {daemonOptions.map((host) => (
              <option key={host} value={host}>
                {host === sourceCodeHost ? `${host} (current)` : host}
              </option>
            ))}
            {!daemonOptions.length ? <option value="">No daemon online</option> : null}
          </select>
          <p className="text-xs text-muted">Where the code lives. Pick a global AI under Backend to run the AI elsewhere.</p>
          {isCodeMove ? (
            <p className="text-xs text-muted">
              The work moves to a different machine than the source task: the new task runs on{' '}
              {effectiveSelectedDaemonHost} and starts from its own copy of the project (or a fresh workspace), not the
              source task&apos;s files. The conversation carries over.
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <label htmlFor={`restart-backend-${task.id}`} className="text-sm font-medium text-ink">
            Backend
          </label>
          <select
            id={`restart-backend-${task.id}`}
            value={effectiveBackendValue}
            onChange={(event) => setSelectedBackend(event.target.value)}
            disabled={!codeAgent || isSubmitting}
            className="w-full rounded-xl border border-border bg-paper px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60"
          >
            {backendOptions.map((backend) => (
              <option key={backend} value={backend}>
                {backend}
              </option>
            ))}
            {!backendOptions.length && currentBackend && !selectedGlobalBackend ? (
              <option value={currentBackend}>{currentBackend}</option>
            ) : null}
            {globalBackendOptions.length > 0 ? (
              <optgroup label="Global">
                {globalBackendOptions.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    disabled={Boolean(option.disabledReason)}
                    title={option.disabledReason ?? undefined}
                  >
                    {option.disabledReason ? `${option.label} — ${option.disabledReason}` : option.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          {selectedGlobalBackend ? (
            <p className="text-xs text-muted">
              AI runs on {selectedGlobalBackend.entry.host} and works on {effectiveSelectedDaemonHost} through conductor
              remote.
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <label htmlFor={`restart-first-message-${task.id}`} className="text-sm font-medium text-ink">
            First message <span className="font-normal text-muted">(optional)</span>
          </label>
          <textarea
            id={`restart-first-message-${task.id}`}
            value={supportsFirstMessage ? firstMessage : ''}
            onChange={(event) => setFirstMessage(event.target.value)}
            disabled={!supportsFirstMessage || isSubmitting}
            rows={3}
            placeholder="Leave empty to have the new task load this task's conversation as background."
            className="webapp-input w-full resize-y disabled:cursor-not-allowed disabled:opacity-60"
          />
          {selectedAgent && !supportsFirstMessage ? (
            <p className="text-xs text-muted">
              Update daemon {selectedAgent.host} to set a first message. The new task will load this task&apos;s
              conversation as background.
            </p>
          ) : null}
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-paper hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleRestart()}
            disabled={Boolean(disabledReason) || isSubmitting}
            title={disabledReason ?? undefined}
            className="webapp-btn-primary rounded-xl px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? 'Working...' : 'New task'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
