'use client';

import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiRequestError, getApiClient } from '@/shared/api/client';
import { useConfirm, useToast } from '@/components/common/FeedbackProvider';
import { useAgentsStore } from '@/features/agents';
import { useProjectsStore } from '@/features/projects';
import type { AchievedTaskSummary } from '@/shared/types';
import { useAchievedTasksStore } from '../store';
import { ReadOnlyTranscript } from './ReadOnlyTranscript';
import { DaemonPickerDialog, type DaemonCandidate } from './DaemonPickerDialog';
import { NewTaskDialog } from './NewTaskDialog';

type UnachievePlan = {
  strategy: 'inplace' | 'new_task';
  agentHost: string;
  taskId: string;
};

type PickerState = {
  task: AchievedTaskSummary;
  candidates: DaemonCandidate[];
  description?: string;
};

type RestartResult = {
  task: {
    id: string;
  };
};

const groupProjectsByName = <
  T extends { id: string; name: string },
>(
  projects: T[],
): Array<{ key: string; name: string; members: T[] }> => {
  const groups = new Map<string, { name: string; members: T[] }>();
  for (const project of projects) {
    const normalizedName = project.name.trim().toLocaleLowerCase();
    const existing = groups.get(normalizedName);
    if (existing) {
      existing.members.push(project);
    } else {
      groups.set(normalizedName, {
        name: project.name,
        members: [project],
      });
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    key: `archived-projects:${group.members
      .map((member) => member.id)
      .sort()
      .join('|')}`,
  }));
};

function HighlightedTitle({ title, query }: { title: string; query: string }) {
  const keyword = query.trim();
  if (!keyword) return title;

  const normalizedTitle = title.toLocaleLowerCase();
  const normalizedKeyword = keyword.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = normalizedTitle.indexOf(normalizedKeyword);

  while (matchIndex >= 0) {
    if (matchIndex > cursor) {
      parts.push(title.slice(cursor, matchIndex));
    }
    const matchEnd = matchIndex + keyword.length;
    parts.push(
      <mark
        key={`${matchIndex}-${matchEnd}`}
        className="rounded-sm bg-[var(--accent)]/20 text-inherit"
      >
        {title.slice(matchIndex, matchEnd)}
      </mark>,
    );
    cursor = matchEnd;
    matchIndex = normalizedTitle.indexOf(normalizedKeyword, cursor);
  }

  if (parts.length === 0) return title;
  if (cursor < title.length) parts.push(title.slice(cursor));
  return parts;
}

const readErrorPayload = (
  error: unknown,
): { status: number; code?: string; message: string; candidates: DaemonCandidate[] } | null => {
  if (!(error instanceof ApiRequestError)) return null;
  const payload = error.payload as unknown as {
    code?: string;
    error?: string;
    message?: string;
    candidates?: DaemonCandidate[];
  };
  return {
    status: error.status,
    code: payload?.code,
    message: payload?.message || payload?.error || error.message,
    candidates: Array.isArray(payload?.candidates) ? payload.candidates : [],
  };
};

export function AchievedTaskManager() {
  const { push } = useRouter();
  const { confirm } = useConfirm();
  const { pushToast } = useToast();
  const tasks = useAchievedTasksStore((state) => state.tasks);
  const query = useAchievedTasksStore((state) => state.query);
  const projectIds = useAchievedTasksStore((state) => state.projectIds);
  const total = useAchievedTasksStore((state) => state.total);
  const page = useAchievedTasksStore((state) => state.page);
  const totalPages = useAchievedTasksStore((state) => state.totalPages);
  const loading = useAchievedTasksStore((state) => state.loading);
  const hydrated = useAchievedTasksStore((state) => state.hydrated);
  const error = useAchievedTasksStore((state) => state.error);
  const search = useAchievedTasksStore((state) => state.search);
  const refresh = useAchievedTasksStore((state) => state.refresh);
  const removeTask = useAchievedTasksStore((state) => state.removeTask);

  const agents = useAgentsStore((state) => state.agents);
  const fetchAgents = useAgentsStore((state) => state.fetchAgents);
  const projects = useProjectsStore((state) => state.projects);
  const fetchProjects = useProjectsStore((state) => state.fetchProjects);

  const [input, setInput] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [pickerBusyHost, setPickerBusyHost] = useState<string | null>(null);
  const [newTask, setNewTask] = useState<AchievedTaskSummary | null>(null);

  // Initial page + keep the connected-daemon list warm for the picker.
  useEffect(() => {
    void search('', 1, []);
    if (typeof fetchAgents === 'function') {
      void fetchAgents({ silent: true });
    }
    if (typeof fetchProjects === 'function') {
      void fetchProjects();
    }
  }, [search, fetchAgents, fetchProjects]);

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setExpandedId(null);
    void search(input, 1, projectIds);
  };

  // This filter intentionally groups by display name only. The main project
  // navigation applies stricter repository/daemon merge rules, but the archive
  // picker is a search facet: one visible name should search every archived
  // task carrying that name, including duplicate rows on the same daemon.
  const projectGroups = useMemo(() => groupProjectsByName(projects), [projects]);
  const selectedProjectGroupKey = useMemo(() => {
    if (projectIds.length === 0) return '';
    const selectedKey = projectIds.slice().sort().join('|');
    return projectGroups.find(
      (group) => group.members.map((member) => member.id).sort().join('|') === selectedKey,
    )?.key ?? '';
  }, [projectGroups, projectIds]);

  const handleProjectChange = (groupKey: string) => {
    const group = projectGroups.find((entry) => entry.key === groupKey);
    setExpandedId(null);
    void search(query, 1, group ? group.members.map((member) => member.id) : []);
  };

  const changePage = (nextPage: number) => {
    if (loading || nextPage < 1 || nextPage > totalPages) return;
    setExpandedId(null);
    void search(query, nextPage);
  };

  const connectedDaemons = useMemo<DaemonCandidate[]>(
    () =>
      (Array.isArray(agents) ? agents : [])
        .filter((agent) => !agent.host.startsWith('conductor-fire-'))
        .map((agent) => ({ host: agent.host, supportedBackends: agent.supportedBackends })),
    [agents],
  );

  const restart = async (
    taskId: string,
    strategy: 'inplace' | 'new_task',
    agentHost?: string,
    backendType?: string,
  ): Promise<RestartResult> => {
    const result = await getApiClient().post<RestartResult>(
      `/tasks/${encodeURIComponent(taskId)}/restart`,
      {
        strategy,
        ...(agentHost ? { agent_host: agentHost } : {}),
        ...(backendType ? { backend_type: backendType } : {}),
      },
    );
    if (!result?.task?.id) {
      throw new Error('Restart did not return a target task');
    }
    return result;
  };

  const unachieve = async (taskId: string, agentHost?: string): Promise<UnachievePlan> => {
    return getApiClient().post<UnachievePlan>(
      `/tasks/${encodeURIComponent(taskId)}/unachieve`,
      agentHost ? { agent_host: agentHost } : {},
    );
  };

  const closePicker = () => {
    setPicker(null);
    setPickerBusyHost(null);
  };

  const navigateToTask = (taskId: string) => {
    push(`/app/tasks/${encodeURIComponent(taskId)}`);
  };

  const handleRecover = async (task: AchievedTaskSummary) => {
    setBusyTaskId(task.id);
    try {
      const plan = await unachieve(task.id);
      const result = await restart(task.id, plan.strategy, plan.agentHost);
      pushToast({
        title: 'Task recovered',
        description: 'The task was restored from this conversation.',
        variant: 'success',
      });
      navigateToTask(result.task.id);
    } catch (err) {
      const info = readErrorPayload(err);
      if (info && info.status === 409 && info.code === 'daemon_offline') {
        setPicker({
          task,
          candidates: info.candidates.length > 0 ? info.candidates : connectedDaemons,
          description: info.message,
        });
      } else {
        pushToast({
          title: 'Failed to recover task',
          description: info?.message ?? (err instanceof Error ? err.message : 'Unknown error'),
          variant: 'error',
        });
      }
    } finally {
      setBusyTaskId(null);
    }
  };

  const handleCreateNewTask = async (host: string, backend: string) => {
    if (!newTask) return;
    setBusyTaskId(newTask.id);
    try {
      const result = await restart(newTask.id, 'new_task', host, backend);
      pushToast({
        title: 'New task created',
        description: `Created on ${host} with ${backend}.`,
        variant: 'success',
      });
      setNewTask(null);
      navigateToTask(result.task.id);
    } catch (err) {
      const info = readErrorPayload(err);
      pushToast({
        title: 'Failed to create task',
        description: info?.message ?? (err instanceof Error ? err.message : 'Unknown error'),
        variant: 'error',
      });
    } finally {
      setBusyTaskId(null);
    }
  };

  const handleDelete = async (task: AchievedTaskSummary) => {
    const accepted = await confirm({
      title: 'Permanently delete this archived task?',
      description:
        'This deletes the task, its complete chat history, attachments, shares, schedules, and stored diagnostics. It cannot be recovered.',
      confirmLabel: 'Delete permanently',
      tone: 'danger',
    });
    if (!accepted) return;

    setBusyTaskId(task.id);
    try {
      await getApiClient().delete(
        `/tasks/${encodeURIComponent(task.id)}?permanent=1`,
      );
      removeTask(task.id);
      setExpandedId((current) => (current === task.id ? null : current));
      await refresh();
      pushToast({
        title: 'Archived task deleted',
        description: 'The task and its retained history were permanently removed.',
        variant: 'success',
      });
    } catch (err) {
      const info = readErrorPayload(err);
      pushToast({
        title: 'Failed to delete archived task',
        description: info?.message ?? (err instanceof Error ? err.message : 'Unknown error'),
        variant: 'error',
      });
    } finally {
      setBusyTaskId(null);
    }
  };

  const handlePick = async (host: string) => {
    if (!picker) return;
    setPickerBusyHost(host);
    try {
      const plan = await unachieve(picker.task.id, host);
      const result = await restart(picker.task.id, plan.strategy, plan.agentHost);
      pushToast({
        title: 'Task recovered',
        description: `Recovered on ${host}.`,
        variant: 'success',
      });
      closePicker();
      navigateToTask(result.task.id);
    } catch (err) {
      const info = readErrorPayload(err);
      pushToast({
        title: 'Failed to recover task',
        description: info?.message ?? (err instanceof Error ? err.message : 'Unknown error'),
        variant: 'error',
      });
      setPickerBusyHost(null);
    }
  };

  const showEmpty = hydrated && !loading && tasks.length === 0;

  return (
    <section className="webapp-card p-5" data-testid="achieved-task-manager">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-[var(--accent)]/10 text-[var(--accent)]">
          <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v1a2 2 0 01-2 2M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8M10 12h4" />
          </svg>
        </div>
        <div className="min-w-0">
          <h3 className="text-lg font-semibold">Achieved tasks</h3>
          <p className="text-sm text-muted">
            {total} archived {total === 1 ? 'task' : 'tasks'}
          </p>
        </div>
      </div>

      <form
        className="mb-3 grid items-stretch gap-2 sm:grid-cols-[minmax(10rem,0.55fr)_minmax(0,1fr)_auto]"
        onSubmit={handleSearch}
      >
        <label className="sr-only" htmlFor="achieved-tasks-project-filter">
          Filter by project
        </label>
        <select
          id="achieved-tasks-project-filter"
          aria-label="Filter by project"
          value={selectedProjectGroupKey}
          onChange={(event) => handleProjectChange(event.target.value)}
          className="webapp-input w-full"
        >
          <option value="">All projects</option>
          {projectGroups.map((group) => (
            <option key={group.key} value={group.key}>
              {group.name}
            </option>
          ))}
        </select>
        <div className="relative min-w-0 flex-1">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
          </svg>
          <input
            type="search"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Search archived tasks..."
            aria-label="Search archived tasks"
            data-testid="achieved-tasks-search"
            className="h-full min-h-12 w-full rounded-lg border border-border bg-paper pl-9 pr-3 text-sm outline-none placeholder:text-muted focus:border-[var(--accent)]/50"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="min-h-12 rounded-lg bg-[var(--accent)] px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Search
        </button>
      </form>

      {error ? (
        <div className="mb-3 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
          {error}
        </div>
      ) : null}

      {!hydrated && loading ? (
        <div className="py-6 text-center text-sm text-muted">Loading...</div>
      ) : showEmpty ? (
        <div className="py-6 text-center text-sm text-muted">
          {query
            ? 'No archived tasks match your search.'
            : projectIds.length > 0
              ? 'No archived tasks in this project.'
              : 'No archived tasks yet'}
        </div>
      ) : (
        <ul className="space-y-2" data-testid="achieved-tasks-list">
          {tasks.map((task) => {
            const isExpanded = expandedId === task.id;
            const isBusy = busyTaskId === task.id;
            return (
              <li
                key={task.id}
                className="rounded-lg border border-border bg-paper"
                data-testid={`achieved-task-${task.id}`}
              >
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : task.id)}
                  aria-expanded={isExpanded}
                  className="flex w-full items-center gap-3 px-3 py-3 text-left"
                >
                  <svg
                    className={`mt-0.5 size-4 shrink-0 text-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    aria-hidden
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                    <HighlightedTitle title={task.title} query={query} />
                  </p>
                </button>

                {isExpanded ? (
                  <div className="border-t border-border">
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <button
                        type="button"
                        onClick={() => setNewTask(task)}
                        disabled={isBusy}
                        className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-ink transition-colors hover:border-[var(--accent)]/40 hover:bg-[var(--accent)]/5 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        New
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRecover(task)}
                        disabled={isBusy}
                        className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-ink transition-colors hover:border-[var(--accent)]/40 hover:bg-[var(--accent)]/5 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                        </svg>
                        {isBusy ? 'Working...' : 'Recover'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(task)}
                        disabled={isBusy}
                        className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-[var(--error)]/30 px-3 text-xs font-medium text-[var(--error)] transition-colors hover:bg-[var(--error)]/10 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        {isBusy ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                    <div className="border-t border-border px-3 py-3">
                      <ReadOnlyTranscript taskId={task.id} />
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {totalPages > 1 ? (
        <nav
          className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4"
          aria-label="Archived tasks pagination"
        >
          <button
            type="button"
            onClick={() => changePage(page - 1)}
            disabled={loading || page <= 1}
            className="rounded-lg border border-border px-3 py-2 text-sm font-medium transition-colors hover:border-[var(--accent)]/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-sm text-muted">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => changePage(page + 1)}
            disabled={loading || page >= totalPages}
            className="rounded-lg border border-border px-3 py-2 text-sm font-medium transition-colors hover:border-[var(--accent)]/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </nav>
      ) : null}

      <DaemonPickerDialog
        open={picker !== null}
        title="Choose a daemon to recover"
        description={picker?.description}
        candidates={picker?.candidates ?? []}
        busyHost={pickerBusyHost}
        onPick={(host) => void handlePick(host)}
        onClose={closePicker}
      />
      <NewTaskDialog
        task={newTask}
        candidates={connectedDaemons}
        busy={Boolean(newTask && busyTaskId === newTask.id)}
        onCreate={(host, backend) => void handleCreateNewTask(host, backend)}
        onClose={() => setNewTask(null)}
      />
    </section>
  );
}
