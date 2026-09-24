'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { InlineNotice } from '@/components/common/InlineNotice';
import { useTasksStore } from '../store';
import { useProjectsStore } from '@/features/projects';
import { excludeArchivedProjects } from '@/features/projects/utils/project-list-order';
import { useAgentsStore } from '@/features/agents';
import { randomTerminalTitle } from '../utils/terminal-title';
import { getCreateTaskErrorMessage } from './CreateTaskDialog';

interface NewTerminalPanelProps {
  onClose: () => void;
  onCreatedTask?: (taskId: string) => void;
}

const supportsPtyTask = (capabilities: string[] | undefined): boolean =>
  Array.isArray(capabilities) && capabilities.some((capability) => capability.trim().toLowerCase() === 'pty_task');

/**
 * "New Terminal" mode inside CreateTaskDialog: a PTY task on a chosen daemon.
 * The project is optional; without one the task goes to the default project
 * and the daemon starts the shell in HOME. That only works while the default
 * project is unbound: a bound default is listed as a regular project instead.
 */
export function NewTerminalPanel({ onClose, onCreatedTask }: NewTerminalPanelProps) {
  const { push } = useRouter();
  const createTask = useTasksStore((state) => state.createTask);
  const projects = useProjectsStore((state) => state.projects);
  const agents = useAgentsStore((state) => state.agents);
  const daemons = agents.filter((agent) => !agent.host.startsWith('conductor-fire-') && supportsPtyTask(agent.capabilities));

  const [requestedHost, setRequestedHost] = useState('');
  const [requestedProjectId, setRequestedProjectId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const host = requestedHost && daemons.some((daemon) => daemon.host === requestedHost)
    ? requestedHost
    : (daemons[0]?.host ?? '');
  const hostProjects = useMemo(
    () => excludeArchivedProjects(projects)
      .filter((project) => project.daemonHost === host && Boolean(project.workspacePath)),
    [projects, host],
  );
  const defaultProject = projects.find((project) => project.isDefault);
  const homeProjectId = defaultProject && !defaultProject.daemonHost ? defaultProject.id : '';
  const projectId = hostProjects.some((project) => project.id === requestedProjectId)
    ? requestedProjectId
    : (homeProjectId || hostProjects[0]?.id || '');

  const handleCreate = async () => {
    if (!host || !projectId || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const task = await createTask({
        title: randomTerminalTitle(),
        projectId,
        taskType: 'pty_task',
        agentHost: host,
        launchConfig: { entrypointType: 'shell' },
      });
      onClose();
      if (onCreatedTask) {
        onCreatedTask(task.id);
        return;
      }
      push(`/app/tasks/${task.id}`);
    } catch (error) {
      setSubmitError(getCreateTaskErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (daemons.length === 0) {
    return (
      <InlineNotice variant="warning" title="No terminal-capable daemon online">
        Connect conductor daemon with PTY support on your computer, then open a terminal from here.
        <a href="/app/settings#devices" className="mt-2 block font-medium underline underline-offset-4">Manage devices</a>
      </InlineNotice>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="new-terminal-daemon" className="mb-2 block text-sm font-medium">Daemon</label>
        <select
          id="new-terminal-daemon"
          value={host}
          onChange={(e) => {
            setRequestedHost(e.target.value);
            setSubmitError(null);
          }}
          className="webapp-input w-full"
        >
          {daemons.map((daemon) => (
            <option key={daemon.host} value={daemon.host}>
              {daemon.host}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="new-terminal-project" className="mb-2 block text-sm font-medium">
          Project {homeProjectId ? <span className="font-normal text-muted">(optional)</span> : null}
        </label>
        <select
          id="new-terminal-project"
          value={projectId === homeProjectId ? '' : projectId}
          onChange={(e) => {
            setRequestedProjectId(e.target.value);
            setSubmitError(null);
          }}
          className="webapp-input w-full"
        >
          {homeProjectId ? <option value="">None (home directory)</option> : null}
          {hostProjects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        {!homeProjectId ? (
          <p className="mt-1 text-xs text-muted">
            {hostProjects.length > 0
              ? 'Your default project is bound to a daemon, so pick a project for this terminal.'
              : 'No project on this daemon. Bind one, or use an unbound default project, to open a terminal here.'}
          </p>
        ) : null}
      </div>

      {submitError ? (
        <InlineNotice variant="error" title="Terminal creation failed">
          {submitError}
        </InlineNotice>
      ) : null}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleCreate}
          disabled={!projectId || isSubmitting}
          className="webapp-btn-primary px-5 py-2.5 text-sm"
        >
          {isSubmitting ? 'Opening...' : 'Open Terminal'}
        </button>
      </div>
    </div>
  );
}
