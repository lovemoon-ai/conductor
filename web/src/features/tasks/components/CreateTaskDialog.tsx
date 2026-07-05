'use client';

import { useMemo, useReducer, useState } from 'react';
import { Dialog } from '@/components/common/Dialog';
import { HelpTip } from '@/components/common/HelpTip';
import { InlineNotice } from '@/components/common/InlineNotice';
import { useTasksStore } from '../store';
import { useProjectsStore } from '@/features/projects';
import { useAgentsStore } from '@/features/agents';
import { ApiRequestError } from '@/shared/api/client';
import { formatBindingLabel } from '@/features/projects';
import { computeProjectGroups } from '@/features/projects/utils/project-groups';
import { useRouter } from 'next/navigation';
import type { TaskType } from '@/lib/tasks/task-config';
import type { Project } from '@/shared/types';

interface CreateTaskDialogProps {
  open: boolean;
  onClose: () => void;
  onCreatedTask?: (taskId: string) => void;
  defaultProjectId?: string | null;
}

const supportsPtyTask = (capabilities: string[] | undefined): boolean =>
  Array.isArray(capabilities) && capabilities.some((capability) => capability.trim().toLowerCase() === 'pty_task');

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

function getCreateTaskErrorMessage(error: unknown): string {
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

const TASK_TYPE_OPTIONS: Array<{
  value: TaskType;
  label: string;
  description: string;
}> = [
  {
    value: 'ai_task',
    label: 'AI Task',
    description: 'Conversation-first task routed through the AI runner. The selected project fixes the daemon, and backend choices come from that daemon.',
  },
  {
    value: 'pty_task',
    label: 'PTY Task',
    description: 'Persistent terminal session on a PTY-capable daemon. A bound project must use a PTY-capable daemon.',
  },
];

interface CreateTaskDialogFormState {
  title: string;
  projectId: string;
  taskType: TaskType;
  createWorktree: boolean;
  agentHost: string;
  backendType: string;
  submitError: string | null;
}

type CreateTaskDialogAction =
  | { type: 'reset' }
  | { type: 'set-title'; title: string }
  | { type: 'set-project'; projectId: string }
  | { type: 'set-task-type'; taskType: TaskType }
  | { type: 'set-create-worktree'; createWorktree: boolean }
  | { type: 'set-agent-host'; agentHost: string }
  | { type: 'set-backend'; backendType: string }
  | { type: 'set-submit-error'; submitError: string | null };

const initialCreateTaskDialogFormState: CreateTaskDialogFormState = {
  title: '',
  projectId: '',
  taskType: 'ai_task',
  createWorktree: false,
  agentHost: '',
  backendType: '',
  submitError: null,
};

function createTaskDialogReducer(
  state: CreateTaskDialogFormState,
  action: CreateTaskDialogAction,
): CreateTaskDialogFormState {
  switch (action.type) {
    case 'reset':
      return initialCreateTaskDialogFormState;
    case 'set-title':
      return { ...state, title: action.title, submitError: null };
    case 'set-project':
      return { ...state, projectId: action.projectId, createWorktree: false, submitError: null };
    case 'set-task-type':
      return {
        ...state,
        taskType: action.taskType,
        createWorktree: action.taskType === 'ai_task' ? state.createWorktree : false,
        submitError: null,
      };
    case 'set-create-worktree':
      return { ...state, createWorktree: action.createWorktree, submitError: null };
    case 'set-agent-host':
      return { ...state, agentHost: action.agentHost, backendType: '', submitError: null };
    case 'set-backend':
      return { ...state, backendType: action.backendType, submitError: null };
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
  const [form, dispatch] = useReducer(createTaskDialogReducer, initialCreateTaskDialogFormState);
  const {
    title,
    projectId: requestedProjectId,
    taskType,
    createWorktree: requestedCreateWorktree,
    agentHost: requestedAgentHost,
    backendType: requestedBackendType,
    submitError,
  } = form;
  const [isSubmitting, setIsSubmitting] = useState(false);

  const createTask = useTasksStore((state) => state.createTask);
  const projects = useProjectsStore((state) => state.projects);
  const agents = useAgentsStore((state) => state.agents);
  const daemons = agents.filter((agent) => !agent.host.startsWith('conductor-fire-'));
  const selectableProjects = projects.filter((project) => Boolean(project.isDefault) || Boolean(project.daemonHost));
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
  const canCreateTaskWorktree = taskType === 'ai_task' && selectedProjectSupportsWorktree;
  const createWorktree = canCreateTaskWorktree ? requestedCreateWorktree : false;
  const hasReadyProjectBinding = isDefaultProject || Boolean(boundDaemonHost);
  const boundDaemonAgent = isBoundProject
    ? daemons.find((agent) => agent.host === boundDaemonHost) ?? null
    : null;
  const boundDaemonOnline = isBoundProject ? Boolean(boundDaemonAgent) : true;
  const boundDaemonSupportsPty = isBoundProject
    ? Boolean(boundDaemonAgent && supportsPtyTask(boundDaemonAgent.capabilities))
    : true;
  const boundBindingLabel = boundDaemonHost ? formatBindingLabel(boundDaemonHost, boundWorkspacePath) : null;
  const daemonScope = isMergedGroup && mergedGroupDaemonOptions
    ? mergedGroupDaemonOptions
        .map((entry) => entry.agent)
        .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
    : isBoundProject
      ? (boundDaemonAgent ? [boundDaemonAgent] : [])
      : daemons;
  const eligibleDaemons = taskType === 'pty_task'
    ? daemonScope.filter((agent) => supportsPtyTask(agent.capabilities))
    : daemonScope;
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
  const canCreatePtyTask = isMergedGroup && mergedGroupDaemonOptions
    ? mergedGroupDaemonOptions.some(
        (entry) => entry.agent && supportsPtyTask(entry.agent.capabilities),
      )
    : isBoundProject
      ? boundDaemonSupportsPty
      : daemons.some((agent) => supportsPtyTask(agent.capabilities));
  const hasEligibleDaemon = eligibleDaemons.length > 0;
  const canSubmit = Boolean(title.trim())
    && selectableProjects.length > 0
    && !isSubmitting
    && hasReadyProjectBinding
    && (isMergedGroup ? hasEligibleDaemon : (!isBoundProject || boundDaemonOnline))
    && (taskType === 'pty_task' ? hasEligibleDaemon : true);
  // Daemon select options. Merged groups list each member's daemon and use
  // the member's projectId as the option value so onChange can re-point the
  // submission target. Other modes keep the previous (host-keyed) behavior.
  const daemonSelectOptions = isMergedGroup && mergedGroupDaemonOptions
    ? mergedGroupDaemonOptions.flatMap((entry) => {
        if (!entry.agent) return [];
        if (taskType === 'pty_task' && !supportsPtyTask(entry.agent.capabilities)) {
          return [];
        }
        return [{
          value: entry.memberId,
          host: entry.host,
          label: entry.host,
        }];
      })
    : isBoundProject && boundDaemonHost
      ? [{ value: boundDaemonHost, host: boundDaemonHost, label: boundDaemonOnline ? boundDaemonHost : `${boundDaemonHost} (offline)` }]
      : eligibleDaemons.map((daemon) => ({ value: daemon.host, host: daemon.host, label: daemon.host }));

  const handleCloseDialog = () => {
    dispatch({ type: 'reset' });
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !projectId) {
      return;
    }
    if (taskType === 'pty_task' && !agentHost) {
      return;
    }

    setIsSubmitting(true);
    dispatch({ type: 'set-submit-error', submitError: null });
    try {
      const task = await createTask({
        title: title.trim(),
        projectId: projectId || undefined,
        taskType,
        agentHost: agentHost || undefined,
        backendType: taskType === 'ai_task' ? backendType || undefined : undefined,
        launchConfig:
          taskType === 'pty_task'
            ? {
                entrypointType: 'shell',
              }
            : (createWorktree ? { worktree: true } : null),
      });
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
      title="Create New Task"
      maxWidthClassName="max-w-2xl"
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="grid gap-5 md:grid-cols-[1.35fr_minmax(0,0.9fr)]">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <label htmlFor="create-task-title" className="block text-sm font-medium">Title</label>
              <HelpTip label="task title">
                Use a short action-oriented title so the task is easy to scan later.
              </HelpTip>
            </div>
            <input
              id="create-task-title"
              type="text"
              aria-label="Task title"
              value={title}
              onChange={(e) => {
                dispatch({ type: 'set-title', title: e.target.value });
              }}
              placeholder="What do you want to accomplish?"
              className="webapp-input w-full"
            />
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2">
              <label htmlFor="create-task-project" className="block text-sm font-medium">Project</label>
              <HelpTip label="project selection">
                {selectableProjects.length === 0
                  ? 'Create a project first to organize the new task.'
                  : 'Tasks inherit the selected project daemon and workspace context.'}
              </HelpTip>
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
        </div>

        <div>
          <span className="mb-2 block text-sm font-medium">Task Type</span>
          <div className="grid gap-3 md:grid-cols-2">
            {TASK_TYPE_OPTIONS.map((option) => {
              const checked = taskType === option.value;
              const disabled = option.value === 'pty_task' && !canCreatePtyTask;
              return (
                <label
                  key={option.value}
                  className={`rounded-2xl border px-4 py-4 transition-all ${
                    checked
                      ? 'border-accent bg-accent/8 shadow-[0_0_0_3px_rgba(228,87,46,0.08)]'
                      : 'border-border bg-paper/60 hover:border-accent/40 hover:bg-panel'
                  } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                >
                  <input
                    type="radio"
                    name="task-type"
                    aria-label={option.label}
                    value={option.value}
                    checked={checked}
                    disabled={disabled}
                    onChange={() => {
                      dispatch({ type: 'set-task-type', taskType: option.value });
                    }}
                    className="sr-only"
                  />
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-ink">{option.label}</span>
                        <HelpTip label={option.label}>
                          {option.description}
                        </HelpTip>
                        {checked ? (
                          <span className="rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">
                            Selected
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <span
                      className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                        checked ? 'border-accent bg-accent text-white' : 'border-border text-transparent'
                      }`}
                      aria-hidden="true"
                    >
                      <svg className="size-3.5" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M16.704 5.29a1 1 0 010 1.42l-7.2 7.2a1 1 0 01-1.414 0l-3-3a1 1 0 111.414-1.42l2.293 2.294 6.493-6.494a1 1 0 011.414 0z" />
                      </svg>
                    </span>
                  </div>
                  {option.value === 'pty_task' && !canCreatePtyTask ? (
                    <div className="mt-3">
                      <HelpTip label="PTY availability">
                        No PTY-capable daemon is online yet. Reconnect conductor daemon with PTY support to enable this mode.
                      </HelpTip>
                    </div>
                  ) : null}
                </label>
              );
            })}
          </div>
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

        <div className="rounded-2xl border border-border bg-paper/50 p-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-ink">Execution</h3>
                <HelpTip label="execution setup">
                  {taskType === 'ai_task'
                    ? (isBoundProject
                      ? 'This project is bound to a daemon, so backend choices come from that daemon.'
                      : 'Pick the connected daemon that should run this AI task. Backend choices come from the selected daemon.')
                    : 'Choose the PTY-capable daemon that should host the terminal session.'}
                </HelpTip>
              </div>
              {isBoundProject ? (
                <p className="mt-1 text-xs text-muted">
                  Bound to {boundBindingLabel}
                </p>
              ) : null}
            </div>
            <span className="rounded-full bg-border/50 px-2.5 py-1 text-xs font-medium text-muted">
              {hasEligibleDaemon
                ? `${eligibleDaemons.length} daemon${eligibleDaemons.length > 1 ? 's' : ''} online`
                : isBoundProject && boundDaemonHost
                  ? 'Daemon offline'
                  : 'No daemon online'}
            </span>
          </div>

          {hasEligibleDaemon ? (
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <label htmlFor="create-task-daemon" className="block text-sm font-medium">Daemon</label>
                  <HelpTip label="daemon">
                    {isBoundProject
                      ? 'The daemon is fixed for this project.'
                      : taskType === 'ai_task'
                        ? 'The selected daemon defines which AI backends are available below.'
                        : 'PTY tasks will open a shell session on this daemon.'}
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

              {taskType === 'ai_task' ? (
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <label htmlFor="create-task-backend" className="block text-sm font-medium">Backend</label>
                    <HelpTip label="backend selection" align="right">
                      {selectedAgent?.host
                        ? `${selectedAgent.host} currently advertises ${availableBackends.length} backend${availableBackends.length > 1 ? 's' : ''}.`
                        : 'Choose a daemon to see backend options.'}
                    </HelpTip>
                  </div>
                  {availableBackends.length > 0 ? (
                    <select
                      id="create-task-backend"
                      value={backendType}
                      onChange={(e) => {
                        dispatch({ type: 'set-backend', backendType: e.target.value });
                      }}
                      className="webapp-input w-full"
                    >
                      {availableBackends.map((backend) => (
                        <option key={backend} value={backend}>
                          {backend}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <InlineNotice variant="warning">
                      This daemon is online, but it does not advertise any AI backends yet. You can still switch daemons before creating the task.
                    </InlineNotice>
                  )}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-border bg-panel/70 p-4">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-ink">Terminal entrypoint</p>
                    <HelpTip label="terminal entrypoint" align="right">
                      PTY tasks start with the default shell entrypoint. Advanced launch presets can be layered on later without changing this flow.
                    </HelpTip>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <InlineNotice variant="warning" className="mt-4">
              {isBoundProject && boundDaemonHost && !boundDaemonOnline
                ? `This project is bound to ${boundDaemonHost}, but the daemon is offline. Reconnect it before creating this task.`
                : isBoundProject && boundDaemonHost && taskType === 'pty_task' && !boundDaemonSupportsPty
                  ? `This project is bound to ${boundDaemonHost}, but it does not support PTY tasks.`
                  : taskType === 'pty_task'
                    ? 'No PTY-capable daemon is online. Reconnect conductor daemon with PTY support before creating this task.'
                    : 'No daemon is online right now. You can still create an AI task, but reconnecting a daemon unlocks explicit backend selection.'}
            </InlineNotice>
          )}
        </div>

        {canCreateTaskWorktree ? (
          <div className="rounded-2xl border border-border bg-paper/50 p-4">
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
                  Each new task from the project gets its own branch. Tasks continued from an existing worktree reuse that same branch.
                </p>
              </div>
            </label>
          </div>
        ) : null}

        {submitError ? (
          <InlineNotice variant="error" title="Task creation failed">
            {submitError}
          </InlineNotice>
        ) : null}

        <div className="flex justify-end gap-3 border-t border-border pt-4">
          <button
            type="button"
            onClick={handleCloseDialog}
            className="rounded-lg px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--border)]/50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="webapp-btn-primary px-5 py-2.5 text-sm"
          >
            {isSubmitting ? 'Creating...' : taskType === 'pty_task' ? 'Create PTY Task' : 'Create AI Task'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
