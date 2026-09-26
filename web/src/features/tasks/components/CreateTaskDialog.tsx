'use client';

import { useEffect, useId, useMemo, useReducer, useState, type MouseEvent } from 'react';
import { z } from 'zod';
import { useAuthStore } from '@/features/auth';
import { Dialog } from '@/components/common/Dialog';
import { HelpTip } from '@/components/common/HelpTip';
import { InlineNotice } from '@/components/common/InlineNotice';
import { useTasksStore } from '../store';
import {
  AgentGroupPicker,
  buildAgentGroupRequest,
  MAX_REVIEWER_ROWS,
  reduceAgentGroup,
  useProjectAgentRegistry,
  type AgentGroupAction,
  type ReviewerRow,
} from './AgentGroupPicker';
import { deriveDefaultTaskTitle } from '../utils/default-task-title';
import { useProjectsStore } from '@/features/projects';
import { useAgentsStore } from '@/features/agents';
import {
  globalAiBackendKey,
  useGlobalAiBackendsStore,
} from '@/features/user-preferences/global-ai-backends';
import { ApiRequestError } from '@/shared/api/client';
import { formatBindingLabel } from '@/features/projects';
import { computeProjectGroups } from '@/features/projects/utils/project-groups';
import { excludeArchivedProjects } from '@/features/projects/utils/project-list-order';
import { useRouter } from 'next/navigation';
import { ResumeSessionPanel } from './ResumeSessionPanel';
import { NewTerminalPanel } from './NewTerminalPanel';
import type { Project } from '@/shared/types';

interface CreateTaskDialogProps {
  open: boolean;
  onClose: () => void;
  onCreatedTask?: (taskId: string) => void;
  defaultProjectId?: string | null;
}

// RFC 0038: a daemon can host a task's worktree only if the AI on the other
// daemon can drive it with `conductor remote exec` (git/build/test) and
// `conductor remote cp` (file transfer). Same predicate as the API.
const supportsRemoteWorktree = (capabilities: string[] | undefined): boolean =>
  Array.isArray(capabilities)
  && ['remote_exec', 'remote_file'].every((required) =>
    capabilities.some((capability) => capability.trim().toLowerCase() === required));

function getCreateTaskLimitMessage(error: unknown): string | null {
  if (!(error instanceof ApiRequestError) || error.status !== 403) {
    return null;
  }

  const limitType = error.payload?.limit_type;
  const backendMessage =
    typeof error.payload?.message === 'string' ? error.payload.message.trim() : '';
  const planName = backendMessage.startsWith('Plus plan') ? 'Plus' : 'Free';
  const taskLimit = planName === 'Plus' ? 10 : 1;
  if (limitType === 'manual_fire_active_task') {
    return `已超出当前套餐限额：${planName} 最多只能有 ${taskLimit} 个活跃 fire task。`;
  }
  if (limitType === 'app_active_task') {
    return `已超出当前套餐限额：${planName} 最多只能有 ${taskLimit} 个活跃 app task。`;
  }

  return error.payload?.message || error.payload?.error || null;
}

export function getCreateTaskErrorMessage(error: unknown): string {
  const limitMessage = getCreateTaskLimitMessage(error);
  if (limitMessage) {
    return limitMessage;
  }

  if (error instanceof ApiRequestError) {
    return error.payload?.message || error.payload?.error || 'Failed to create task.';
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return 'Failed to create task.';
}

interface CreateTaskDialogFormState {
  title: string;
  /**
   * The task's opening prompt. For a multi-agent group this becomes the worker
   * (first agent) bootstrap's `--- Task ---` section, which is what actually
   * gives the group something to do; without it the worker starts with only
   * "read your agent doc" and the group sits idle.
   */
  initialContent: string;
  projectId: string;
  createWorktree: boolean;
  /** RFC 0039: create the task as a persistent task. */
  persistent: boolean;
  /**
   * RFC 0038: daemon that hosts this task's git worktree while the AI runs on
   * `agentHost`. Empty = the worktree (if any) is local to the AI's daemon.
   */
  remoteWorktreeHost: string;
  agentHost: string;
  backendType: string;
  /**
   * RFC 0041: `globalAiBackendKey` of the chosen global backend, or empty for
   * one of the project daemon's own backends.
   */
  globalBackendKey: string;
  workerAgent: string;
  reviewers: ReviewerRow[];
  submitError: string | null;
}

type CreateTaskDialogAction =
  | { type: 'reset' }
  | { type: 'restore'; form: CreateTaskDialogFormState }
  | { type: 'set-title'; title: string }
  | { type: 'set-initial-content'; initialContent: string }
  | { type: 'set-project'; projectId: string }
  | { type: 'set-create-worktree'; createWorktree: boolean }
  | { type: 'set-persistent'; persistent: boolean }
  | { type: 'set-remote-worktree-host'; remoteWorktreeHost: string }
  | { type: 'set-agent-host'; agentHost: string }
  | { type: 'set-backend'; backendType: string }
  | { type: 'set-global-backend'; globalBackendKey: string }
  | AgentGroupAction
  | { type: 'set-submit-error'; submitError: string | null };

const initialCreateTaskDialogFormState: CreateTaskDialogFormState = {
  title: '',
  initialContent: '',
  projectId: '',
  createWorktree: false,
  persistent: false,
  remoteWorktreeHost: '',
  agentHost: '',
  backendType: '',
  globalBackendKey: '',
  workerAgent: '',
  reviewers: [],
  submitError: null,
};

// Only retained for the device-setup detour, in this tab and for this user.
const taskDraftSchema = z.object({
  title: z.string(),
  initialContent: z.string(),
  projectId: z.string(),
  createWorktree: z.boolean(),
  persistent: z.boolean().default(false),
  remoteWorktreeHost: z.string().default(''),
  agentHost: z.string(),
  backendType: z.string(),
  globalBackendKey: z.string().default(''),
  workerAgent: z.string(),
  reviewers: z.array(z.object({ name: z.string(), backend: z.string() })).max(MAX_REVIEWER_ROWS),
  submitError: z.null(),
});

function clearDeviceSetupDraft(key: string | null) {
  if (!key) return;
  try { sessionStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
}

function createTaskDialogReducer(
  state: CreateTaskDialogFormState,
  action: CreateTaskDialogAction,
): CreateTaskDialogFormState {
  switch (action.type) {
    case 'restore':
      return action.form;
    case 'reset':
      return initialCreateTaskDialogFormState;
    case 'set-title':
      return { ...state, title: action.title, submitError: null };
    case 'set-initial-content':
      return { ...state, initialContent: action.initialContent, submitError: null };
    case 'set-project':
      return {
        ...state,
        projectId: action.projectId,
        createWorktree: false,
        remoteWorktreeHost: '',
        workerAgent: '',
        reviewers: [],
        submitError: null,
      };
    // A local worktree and a remote one are mutually exclusive (the API rejects
    // both), so picking one clears the other.
    case 'set-create-worktree':
      return {
        ...state,
        createWorktree: action.createWorktree,
        remoteWorktreeHost: action.createWorktree ? '' : state.remoteWorktreeHost,
        submitError: null,
      };
    case 'set-persistent':
      return { ...state, persistent: action.persistent, submitError: null };
    case 'set-remote-worktree-host':
      return {
        ...state,
        remoteWorktreeHost: action.remoteWorktreeHost,
        createWorktree: action.remoteWorktreeHost ? false : state.createWorktree,
        // Only offered while no global backend is in effect; a remembered but
        // unavailable one must not silently come back and drop this choice.
        globalBackendKey: action.remoteWorktreeHost ? '' : state.globalBackendKey,
        submitError: null,
      };
    // The daemon that runs the AI changed; the remote host may now be that
    // daemon itself, so the choice is re-made.
    case 'set-agent-host':
      return { ...state, agentHost: action.agentHost, backendType: '', remoteWorktreeHost: '', submitError: null };
    case 'set-backend':
      return { ...state, backendType: action.backendType, globalBackendKey: '', submitError: null };
    // A global backend runs the AI elsewhere, so the 0038 remote worktree and
    // agent groups (both unsupported with it) are dropped; worktree stays.
    case 'set-global-backend':
      return {
        ...state,
        globalBackendKey: action.globalBackendKey,
        remoteWorktreeHost: '',
        workerAgent: '',
        reviewers: [],
        submitError: null,
      };
    // Same for agent groups, which a global backend does not support.
    case 'set-worker-agent':
      return {
        ...reduceAgentGroup(state, action),
        globalBackendKey: action.workerAgent ? '' : state.globalBackendKey,
        submitError: null,
      };
    case 'add-reviewer':
    case 'remove-reviewer':
    case 'set-reviewer-name':
    case 'set-reviewer-backend':
    case 'reconcile-agent-registry':
      return { ...reduceAgentGroup(state, action), submitError: null };
    case 'set-submit-error':
      return { ...state, submitError: action.submitError };
    default:
      return state;
  }
}

export function CreateTaskDialog({
  open,
  onClose,
  onCreatedTask,
  defaultProjectId = null,
}: CreateTaskDialogProps) {
  const { push } = useRouter();
  const formId = useId();
  const userId = useAuthStore((state) => state.session?.user.id);
  const draftKey = userId ? `conductor-create-task-draft:${userId}` : null;
  const [form, dispatch] = useReducer(createTaskDialogReducer, initialCreateTaskDialogFormState);
  useEffect(() => {
    if (!open || !draftKey) return;
    try {
      const raw = sessionStorage.getItem(draftKey);
      if (!raw) return;
      const restored = taskDraftSchema.safeParse(JSON.parse(raw));
      if (restored.success) dispatch({ type: 'restore', form: restored.data });
      else clearDeviceSetupDraft(draftKey);
    } catch {
      clearDeviceSetupDraft(draftKey);
    }
  }, [open, draftKey]);
  // 'create' = the regular new-task form; 'terminal' = a PTY task
  // (NewTerminalPanel); 'resume' = pick up an existing AI session found on a
  // daemon (ResumeSessionPanel).
  const [mode, setMode] = useState<'create' | 'terminal' | 'resume'>('create');
  const {
    title,
    initialContent,
    projectId: requestedProjectId,
    createWorktree: requestedCreateWorktree,
    persistent,
    remoteWorktreeHost: requestedRemoteWorktreeHost,
    agentHost: requestedAgentHost,
    backendType: requestedBackendType,
    globalBackendKey: requestedGlobalBackendKey,
    workerAgent,
    reviewers,
    submitError,
  } = form;
  // Named worker agent, if any — used to make the prompt hint concrete.
  const [isSubmitting, setIsSubmitting] = useState(false);

  const createTask = useTasksStore((state) => state.createTask);
  const projects = useProjectsStore((state) => state.projects);
  const agents = useAgentsStore((state) => state.agents);
  const daemons = agents.filter((agent) => !agent.host.startsWith('conductor-fire-'));
  const globalBackends = useGlobalAiBackendsStore((state) => state.backends);
  const globalBackendsHydrated = useGlobalAiBackendsStore((state) => state.hydrated);
  const hydrateGlobalBackends = useGlobalAiBackendsStore((state) => state.hydrate);
  useEffect(() => {
    if (open && !globalBackendsHydrated) void hydrateGlobalBackends();
  }, [open, globalBackendsHydrated, hydrateGlobalBackends]);
  // Archived (hidden) projects are excluded: hiding a project in the Project
  // List archives it, so it must not be offered as a target for new tasks.
  const selectableProjects = excludeArchivedProjects(projects)
    .filter((project) => Boolean(project.isDefault) || Boolean(project.daemonHost));
  // Merge same-name git projects across daemons into one picker entry; the
  // user picks the project name once and a separate daemon dropdown decides
  // which daemon's underlying project the task lands on. Single-member
  // groups behave exactly as before.
  const projectGroups = useMemo(
    () => computeProjectGroups(selectableProjects),
    [selectableProjects],
  );
  const resolvedDefaultProjectId = useMemo(() => {
    if (projectGroups.length === 0) {
      return '';
    }
    if (defaultProjectId && selectableProjects.some((project) => project.id === defaultProjectId)) {
      return defaultProjectId;
    }
    return projectGroups[0].members[0].id;
  }, [defaultProjectId, projectGroups, selectableProjects]);
  const normalizedProjectId = requestedProjectId && selectableProjects.some((project) => project.id === requestedProjectId)
    ? requestedProjectId
    : '';
  const baseProjectId = normalizedProjectId || resolvedDefaultProjectId;
  const currentGroup = useMemo(() => {
    if (!baseProjectId) return null;
    return projectGroups.find((group) =>
      group.members.some((member) => member.id === baseProjectId),
    ) ?? null;
  }, [baseProjectId, projectGroups]);
  const isMergedGroup = (currentGroup?.members.length ?? 0) > 1;
  // For merged cross-daemon groups, daemon scope is the set of online
  // daemons that own a member of the group. Picking a daemon in this case
  // also re-points the projectId at that daemon's underlying member.
  const mergedGroupDaemonOptions = useMemo(() => {
    if (!isMergedGroup || !currentGroup) return null;
    return currentGroup.members
      .map((member) => {
        const host = typeof member.daemonHost === 'string' ? member.daemonHost.trim() : '';
        if (!host) return null;
        const agent = daemons.find((daemon) => daemon.host === host) ?? null;
        return { memberId: member.id, host, agent };
      })
      .filter((entry): entry is { memberId: string; host: string; agent: typeof daemons[number] | null } =>
        entry !== null,
      );
  }, [currentGroup, daemons, isMergedGroup]);
  const projectId = useMemo(() => {
    if (!baseProjectId) {
      return '';
    }
    if (!isMergedGroup || !mergedGroupDaemonOptions || mergedGroupDaemonOptions.length === 0) {
      return baseProjectId;
    }
    return mergedGroupDaemonOptions.some((entry) => entry.memberId === baseProjectId)
      ? baseProjectId
      : mergedGroupDaemonOptions[0].memberId;
  }, [baseProjectId, isMergedGroup, mergedGroupDaemonOptions]);
  // Picker value tracks the group's primary member id so the option matches
  // even when projectId points at a non-primary member (i.e. the user picked
  // a specific daemon inside a merged group).
  const projectPickerValue = currentGroup?.members[0]?.id ?? projectId;
  const selectedProject = selectableProjects.find((project) => project.id === projectId) ?? null;
  const projectRecord = selectedProject as (Project & Record<string, unknown>) | null;
  const isDefaultProject = Boolean(projectRecord?.isDefault);
  const boundDaemonHost = projectRecord && typeof projectRecord.daemonHost === 'string'
    ? projectRecord.daemonHost
    : null;
  const boundWorkspacePath = projectRecord && typeof projectRecord.workspacePath === 'string'
    ? projectRecord.workspacePath
    : null;
  const projectRepoRoot = projectRecord && typeof projectRecord.repoRoot === 'string'
    ? projectRecord.repoRoot
    : null;
  const isBoundProject = Boolean(boundDaemonHost) && !isDefaultProject;
  const selectedProjectSupportsWorktree = Boolean(projectRepoRoot);
  const canCreateTaskWorktree = selectedProjectSupportsWorktree;
  const createWorktree = canCreateTaskWorktree ? requestedCreateWorktree : false;
  // RFC 0038: the other members of a merged group whose daemon is online and
  // can host a remote worktree. Only ai_task, only without an agent group (the
  // API rejects remoteWorktree for groups), and never the AI's own daemon.
  const remoteWorktreeOptions = useMemo(() => {
    if (!isMergedGroup || !mergedGroupDaemonOptions) return [];
    return mergedGroupDaemonOptions.flatMap((entry) => {
      if (entry.memberId === projectId || !entry.agent || !supportsRemoteWorktree(entry.agent.capabilities)) {
        return [];
      }
      const member = currentGroup?.members.find((candidate) => candidate.id === entry.memberId) as
        | (Project & Record<string, unknown>)
        | undefined;
      const repoRoot = member && typeof member.repoRoot === 'string' ? member.repoRoot.trim() : '';
      if (!repoRoot) return [];
      const workspacePath = member && typeof member.workspacePath === 'string' ? member.workspacePath : null;
      return [{ host: entry.host, label: formatBindingLabel(entry.host, workspacePath) }];
    });
  }, [currentGroup, isMergedGroup, mergedGroupDaemonOptions, projectId]);
  const remoteWorktreeBlockedByAgents = Boolean(workerAgent.trim());
  // RFC 0041: global backends from settings, for a project bound to a daemon.
  // The project's own daemon is not listed (its backends already are); the
  // rest are shown greyed out with the reason when they cannot run now.
  const globalBackendOptions = useMemo(() => {
    const codeHost = (isMergedGroup || isBoundProject) ? boundDaemonHost : null;
    if (!codeHost) return [];
    const codeAgent = daemons.find((daemon) => daemon.host === codeHost) ?? null;
    return globalBackends
      .filter((entry) => entry.host !== codeHost)
      .map((entry) => {
        const agent = daemons.find((daemon) => daemon.host === entry.host && !daemon.shared) ?? null;
        const disabledReason = !agent
          ? `${entry.host} is offline`
          : !codeAgent
            ? `${codeHost} is offline`
            : !(agent.supportedBackends ?? []).includes(entry.backend)
              ? `${entry.backend} is not available on ${entry.host}`
              : !supportsRemoteWorktree(codeAgent.capabilities)
                ? `${codeHost} does not support conductor remote; upgrade its daemon`
                : null;
        return {
          key: globalAiBackendKey(entry),
          entry,
          label: `${entry.backend} @ ${entry.host}`,
          disabledReason,
        };
      });
  }, [boundDaemonHost, daemons, globalBackends, isBoundProject, isMergedGroup]);
  const selectedGlobalBackend = globalBackendOptions.find(
    (option) => option.key === requestedGlobalBackendKey && !option.disabledReason,
  ) ?? null;
  const canUseRemoteWorktree = remoteWorktreeOptions.length > 0
    && !remoteWorktreeBlockedByAgents
    && !selectedGlobalBackend;
  const remoteWorktreeHost = canUseRemoteWorktree
    && remoteWorktreeOptions.some((option) => option.host === requestedRemoteWorktreeHost)
    ? requestedRemoteWorktreeHost
    : '';
  const hasReadyProjectBinding = isDefaultProject || Boolean(boundDaemonHost);
  const boundDaemonAgent = isBoundProject
    ? daemons.find((agent) => agent.host === boundDaemonHost) ?? null
    : null;
  const boundDaemonOnline = isBoundProject ? Boolean(boundDaemonAgent) : true;
  const boundBindingLabel = boundDaemonHost ? formatBindingLabel(boundDaemonHost, boundWorkspacePath) : null;
  const daemonScope = isMergedGroup && mergedGroupDaemonOptions
    ? mergedGroupDaemonOptions
      .map((entry) => entry.agent)
      .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
    : isBoundProject
      ? (boundDaemonAgent ? [boundDaemonAgent] : [])
      : daemons;
  const eligibleDaemons = daemonScope;
  const agentHost = useMemo(() => {
    if (isMergedGroup || isBoundProject) {
      return boundDaemonHost ?? '';
    }
    return requestedAgentHost && eligibleDaemons.some((daemon) => daemon.host === requestedAgentHost)
      ? requestedAgentHost
      : (eligibleDaemons[0]?.host || '');
  }, [boundDaemonHost, eligibleDaemons, isBoundProject, isMergedGroup, requestedAgentHost]);
  const selectedAgent = agentHost
    ? eligibleDaemons.find((agent) => agent.host === agentHost) ?? null
    : null;
  const availableBackends = selectedAgent?.supportedBackends || [];
  const backendType = requestedBackendType && availableBackends.includes(requestedBackendType)
    ? requestedBackendType
    : (availableBackends[0] ?? '');
  const hasEligibleDaemon = eligibleDaemons.length > 0;
  const resolvedTitle = title.trim() || deriveDefaultTaskTitle(initialContent);
  const canSubmit = Boolean(resolvedTitle)
    && selectableProjects.length > 0
    && !isSubmitting
    && hasReadyProjectBinding
    && (isMergedGroup ? hasEligibleDaemon : (!isBoundProject || boundDaemonOnline))
    && hasEligibleDaemon;
  // Daemon select options. Merged groups list each member's daemon and use
  // the member's projectId as the option value so onChange can re-point the
  // submission target. Other modes keep the previous (host-keyed) behavior.
  const daemonSelectOptions = isMergedGroup && mergedGroupDaemonOptions
    ? mergedGroupDaemonOptions.flatMap((entry) => {
      if (!entry.agent) return [];
      return [{
        value: entry.memberId,
        host: entry.host,
        label: entry.host,
      }];
    })
    : isBoundProject && boundDaemonHost
      ? [{ value: boundDaemonHost, host: boundDaemonHost, label: boundDaemonOnline ? boundDaemonHost : `${boundDaemonHost} (offline)` }]
      : eligibleDaemons.map((daemon) => ({ value: daemon.host, host: daemon.host, label: daemon.host }));

  // RFC 0033: agents registered in the selected project's .conductor/settings.yaml.
  const { availableAgents, isLoadingAgents, agentsLoadFailed } = useProjectAgentRegistry(
    open && projectId ? projectId : null,
    dispatch,
  );

  const handleManageDevices = (event: MouseEvent<HTMLAnchorElement>) => {
    try {
      if (!draftKey) throw new Error('No signed-in user');
      sessionStorage.setItem(draftKey, JSON.stringify({
        ...form,
        projectId,
        agentHost: requestedAgentHost || agentHost,
        backendType: requestedBackendType || backendType,
        submitError: null,
      }));
    } catch {
      // Keep the user and their instructions here if storage is unavailable.
      event.preventDefault();
      dispatch({ type: 'set-submit-error', submitError: 'Unable to save your draft. Open Settings in another tab to connect a device.' });
    }
  };

  const handleCloseDialog = () => {
    clearDeviceSetupDraft(draftKey);
    dispatch({ type: 'reset' });
    setMode('create');
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resolvedTitle || !projectId) {
      return;
    }
    // RFC 0033: assemble the multi-agent group.
    const trimmedInitialContent = initialContent.trim();
    const agents = selectedGlobalBackend ? null : buildAgentGroupRequest({ workerAgent, reviewers });

    setIsSubmitting(true);
    dispatch({ type: 'set-submit-error', submitError: null });
    try {
      const task = await createTask({
        title: resolvedTitle,
        projectId: projectId || undefined,
        taskType: 'ai_task',
        ...(selectedGlobalBackend
          ? {
            globalBackend: selectedGlobalBackend.entry,
            backendType: selectedGlobalBackend.entry.backend,
          }
          : {
            agentHost: agentHost || undefined,
            backendType: backendType || undefined,
          }),
        ...(agents ? { agents } : {}),
        ...(trimmedInitialContent ? { initialContent: trimmedInitialContent } : {}),
        ...(persistent ? { metadata: { persistent: { enabled: true } } } : {}),
        launchConfig: remoteWorktreeHost
          ? { remoteWorktree: { host: remoteWorktreeHost } }
          : (createWorktree ? { worktree: true } : null),
      });
      clearDeviceSetupDraft(draftKey);
      dispatch({ type: 'reset' });
      onClose();
      if (onCreatedTask) {
        onCreatedTask(task.id);
        return;
      }
      push(`/app/tasks/${task.id}`);
    } catch (error) {
      dispatch({ type: 'set-submit-error', submitError: getCreateTaskErrorMessage(error) });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleCloseDialog}
      title={mode === 'resume' ? 'Resume Session' : mode === 'terminal' ? 'New Terminal' : 'Create New Task'}
      maxWidthClassName="max-w-2xl"
      mobileSheet
      footer={mode === 'create' ? (
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={handleCloseDialog}
            className="rounded-lg px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--border)]/50"
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            disabled={!canSubmit}
            className="webapp-btn-primary px-5 py-2.5 text-sm"
          >
            {isSubmitting ? 'Creating...' : 'Create AI Task'}
          </button>
        </div>
      ) : undefined}
    >
      <div
        role="tablist"
        aria-label="Task creation mode"
        className="mb-5 inline-flex rounded-xl border border-border bg-paper/60 p-1"
      >
        {([
          { value: 'create', label: 'New Task' },
          { value: 'terminal', label: 'New Terminal' },
          { value: 'resume', label: 'Resume Session' },
        ] as const).map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={mode === option.value}
            onClick={() => setMode(option.value)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${mode === option.value ? 'bg-panel text-ink shadow-sm' : 'text-muted hover:text-ink'
              }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {mode === 'resume' ? (
        <ResumeSessionPanel onClose={handleCloseDialog} onCreatedTask={onCreatedTask} />
      ) : mode === 'terminal' ? (
        <NewTerminalPanel onClose={handleCloseDialog} onCreatedTask={onCreatedTask} />
      ) : (
        <form id={formId} onSubmit={handleSubmit} className="create-task-form space-y-5">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <label htmlFor="create-task-prompt" className="block text-sm font-medium">
                What would you like to do?
              </label>
            </div>
            <textarea
              id="create-task-prompt"
              aria-label="Task prompt"
              value={initialContent}
              onChange={(e) => {
                dispatch({ type: 'set-initial-content', initialContent: e.target.value });
              }}
              rows={4}
              autoFocus
              placeholder="Describe a change, ask a question, or give your agent a task…"
              className="webapp-input w-full resize-y"
            />
          </div>


          <div>
            <div className="mb-2 flex items-center gap-2">
              <label htmlFor="create-task-project" className="block text-sm font-medium">Project</label>
            </div>
            <select
              id="create-task-project"
              value={projectPickerValue}
              onChange={(e) => {
                // Picker option value is always the group's primary member id.
                // For merged groups, the daemon dropdown then narrows down to
                // a specific member.
                dispatch({ type: 'set-project', projectId: e.target.value });
              }}
              className="webapp-input w-full"
              disabled={projectGroups.length === 0}
            >
              {projectGroups.map((group) => {
                const primary = group.members[0];
                return (
                  <option key={group.key} value={primary.id}>
                    {group.isMerged
                      ? `${group.name} (${group.members.length} daemons)`
                      : group.name}
                  </option>
                );
              })}
            </select>
          </div>
          {selectableProjects.length === 0 ? (
            <InlineNotice variant="warning" title="No project available">
              Create a project first, then come back to launch the task from the right workspace.
            </InlineNotice>
          ) : null}

          {selectedProject && !hasReadyProjectBinding ? (
            <InlineNotice variant="warning" title="Binding pending">
              This project is waiting for daemon confirmation. Confirm the binding from the daemon or CLI before creating tasks.
            </InlineNotice>
          ) : null}

          <div className="rounded-xl border border-border p-4">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-ink">Run on</h3>
                </div>
                {isBoundProject ? (
                  <p className="mt-1 text-xs text-muted">
                    Bound to {boundBindingLabel}
                  </p>
                ) : null}
              </div>
              <span className="rounded-full bg-border/50 px-2.5 py-1 text-xs font-medium text-muted">
                {hasEligibleDaemon
                  ? `${eligibleDaemons.length} device${eligibleDaemons.length > 1 ? 's' : ''} available`
                  : isBoundProject && boundDaemonHost
                    ? 'Device offline'
                    : 'No devices available'}
              </span>
            </div>

            {hasEligibleDaemon ? (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <label htmlFor="create-task-daemon" className="block text-sm font-medium">Device</label>
                    <HelpTip label="daemon">
                      {isBoundProject
                        ? 'The daemon is fixed for this project.'
                        : 'The selected daemon defines which AI backends are available below.'}
                    </HelpTip>
                  </div>
                  <select
                    id="create-task-daemon"
                    value={isMergedGroup ? projectId : agentHost}
                    onChange={(e) => {
                      if (isMergedGroup) {
                        // For merged groups the option value IS the member's
                        // projectId — switching daemon means switching which
                        // daemon's underlying project receives the task.
                        dispatch({ type: 'set-project', projectId: e.target.value });
                      } else {
                        dispatch({ type: 'set-agent-host', agentHost: e.target.value });
                      }
                    }}
                    className="webapp-input w-full"
                    disabled={!isMergedGroup && isBoundProject}
                  >
                    {daemonSelectOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <label htmlFor="create-task-backend" className="block text-sm font-medium">AI backend</label>
                    <HelpTip label="backend selection" align="right">
                      {selectedAgent?.host
                        ? `${selectedAgent.host} currently advertises ${availableBackends.length} backend${availableBackends.length > 1 ? 's' : ''}.`
                        : 'Choose a daemon to see backend options.'}
                    </HelpTip>
                  </div>
                  {availableBackends.length > 0 || globalBackendOptions.some((option) => !option.disabledReason) ? (
                    <>
                      <select
                        id="create-task-backend"
                        value={selectedGlobalBackend ? `global:${selectedGlobalBackend.key}` : backendType}
                        onChange={(e) => {
                          const { value } = e.target;
                          if (value.startsWith('global:')) {
                            dispatch({ type: 'set-global-backend', globalBackendKey: value.slice('global:'.length) });
                          } else {
                            dispatch({ type: 'set-backend', backendType: value });
                          }
                        }}
                        className="webapp-input w-full"
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
                            {globalBackendOptions.map((option) => (
                              <option
                                key={option.key}
                                value={`global:${option.key}`}
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
                        <p className="mt-1 text-xs text-muted">
                          AI runs on {selectedGlobalBackend.entry.host} and works on {agentHost} through conductor remote.
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <InlineNotice variant="warning">
                      This daemon is online, but it does not advertise any AI backends yet. You can still switch daemons before creating the task.
                    </InlineNotice>
                  )}


                </div>
              </div>
            ) : (
              <InlineNotice variant="warning" className="mt-4">
                {isBoundProject && boundDaemonHost && !boundDaemonOnline
                  ? `This project is bound to ${boundDaemonHost}, but the daemon is offline. Reconnect it before creating this task.`
                  : 'Connect a device to run this task. You can keep writing your instructions here.'}
                <a href="/app/settings#devices" onClick={handleManageDevices} className="mt-2 block font-medium underline underline-offset-4">Manage devices</a>
              </InlineNotice>
            )}
          </div>

          <details className="rounded-xl border border-border p-4">
            <summary className="font-medium">Advanced options</summary>
            <div className="mt-5 space-y-5">
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <label htmlFor="create-task-title" className="block text-sm font-medium">Title <span className="font-normal text-muted">(optional)</span></label>
                </div>
                <input
                  id="create-task-title"
                  type="text"
                  aria-label="Task title"
                  value={title}
                  onChange={(e) => {
                    dispatch({ type: 'set-title', title: e.target.value });
                  }}
                  placeholder={resolvedTitle || 'Generated from your instructions'}
                  className="webapp-input w-full"
                />
              </div>

              <div className="rounded-xl border border-border p-4">
                <label htmlFor="create-task-persistent" className="flex cursor-pointer items-start gap-3">
                  <input
                    id="create-task-persistent"
                    type="checkbox"
                    aria-label="Persistent task"
                    checked={persistent}
                    onChange={(e) => {
                      dispatch({ type: 'set-persistent', persistent: e.target.checked });
                    }}
                    className="mt-0.5 size-4 rounded border-border text-[var(--accent)] focus:ring-[var(--accent)]"
                  />
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-ink">Persistent task</span>
                    <p className="mt-1 text-xs text-muted">
                      For recurring work. Each round starts a fresh AI session; the task keeps the whole history.
                    </p>
                  </div>
                </label>
              </div>

              {canCreateTaskWorktree ? (
                <div className="rounded-xl border border-border p-4">
                  <label htmlFor="create-task-worktree" className="flex cursor-pointer items-start gap-3">
                    <input
                      id="create-task-worktree"
                      type="checkbox"
                      aria-label="Create task in a separate worktree"
                      checked={createWorktree}
                      onChange={(e) => {
                        dispatch({ type: 'set-create-worktree', createWorktree: e.target.checked });
                      }}
                      className="mt-0.5 size-4 rounded border-border text-[var(--accent)] focus:ring-[var(--accent)]"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-ink">worktree</span>
                        <HelpTip label="worktree" align="right">
                          Create this task in an isolated git worktree and branch for the selected project.
                        </HelpTip>
                      </div>
                      <p className="mt-1 text-xs text-muted">
                        {selectedGlobalBackend
                          ? `The AI creates the branch on ${agentHost}, where the code lives; it is cleaned up when the task is deleted or archived.`
                          : 'Each new task from the project gets its own branch. Tasks continued from an existing worktree reuse that same branch.'}
                      </p>
                    </div>
                  </label>
                </div>
              ) : null}

              {remoteWorktreeOptions.length > 0 && !selectedGlobalBackend ? (
                <div className="rounded-xl border border-border p-4">
                  <div className="flex items-center gap-2">
                    <label htmlFor="create-task-remote-worktree" className="text-sm font-medium text-ink">
                      Workspace on another daemon
                    </label>
                    <HelpTip label="remote worktree" align="right">
                      Run the AI on {agentHost || 'the selected daemon'} but create the git worktree, build and
                      test on the chosen daemon. The AI drives that machine through conductor remote; its
                      local copy of the repository stays read-only.
                    </HelpTip>
                  </div>
                  <select
                    id="create-task-remote-worktree"
                    aria-label="Workspace on another daemon"
                    value={remoteWorktreeHost}
                    disabled={remoteWorktreeBlockedByAgents}
                    onChange={(e) => {
                      dispatch({ type: 'set-remote-worktree-host', remoteWorktreeHost: e.target.value });
                    }}
                    className="webapp-input mt-2 w-full"
                  >
                    <option value="">Same daemon as the AI (default)</option>
                    {remoteWorktreeOptions.map((option) => (
                      <option key={option.host} value={option.host}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-muted">
                    {remoteWorktreeBlockedByAgents
                      ? 'Not available together with an agent group.'
                      : remoteWorktreeHost
                        ? `A new branch is created on ${remoteWorktreeHost} and cleaned up when the task is deleted or archived.`
                        : 'Use when this daemon has the AI account but the other one has the build or hardware environment.'}
                  </p>
                </div>
              ) : null}


              {hasEligibleDaemon && !selectedGlobalBackend ? (
                <div className="mt-4 border-t border-border pt-4">
                  <div className="mb-2 flex items-center gap-2">
                    <label htmlFor="create-task-worker-agent" className="block text-sm font-medium">
                      Agents <span className="text-muted">(optional)</span>
                    </label>
                    <HelpTip label="agents" align="right">
                      Pick a worker agent to run this task, and optionally reviewer agents that
                      periodically review it (each can use its own backend). Agents are
                      registered per project in .conductor/settings.yaml. Leave as “None” for a
                      plain task.
                    </HelpTip>
                  </div>
                  <AgentGroupPicker
                    id="create-task-worker-agent"
                    availableAgents={availableAgents}
                    isLoadingAgents={isLoadingAgents}
                    agentsLoadFailed={agentsLoadFailed}
                    availableBackends={availableBackends}
                    workerAgent={workerAgent}
                    reviewers={reviewers}
                    dispatch={dispatch}
                    onSelectBackend={(backend) => dispatch({ type: 'set-backend', backendType: backend })}
                  />
                </div>
              ) : null}
            </div>
          </details>

          {submitError ? (
            <InlineNotice variant="error" title="Task creation failed">
              {submitError}
            </InlineNotice>
          ) : null}


        </form>
      )}
    </Dialog>
  );
}
