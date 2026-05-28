'use client';

import { useReducer, useRef, useState } from 'react';
import { Dialog } from '@/components/common/Dialog';
import { useProjectsStore } from '../store';
import { useAgentsStore } from '@/features/agents';

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

const deriveProjectNameFromWorkspacePath = (workspacePath: string) => {
  const normalized = workspacePath.trim().replace(/[\\/]+$/, '');
  if (!normalized) return '';

  const parts = normalized.split(/[\\/]+/);
  return parts[parts.length - 1] ?? '';
};

type CreateProjectDialogState = {
  daemonHost: string;
  projectPath: string;
  name: string;
};

type CreateProjectDialogAction =
  | { type: 'set-daemon-host'; value: string }
  | { type: 'set-project-path'; value: string; preserveName: boolean }
  | { type: 'set-name'; value: string }
  | { type: 'reset' };

const initialCreateProjectDialogState: CreateProjectDialogState = {
  daemonHost: '',
  projectPath: '',
  name: '',
};

function createProjectDialogReducer(
  state: CreateProjectDialogState,
  action: CreateProjectDialogAction,
): CreateProjectDialogState {
  switch (action.type) {
    case 'set-daemon-host':
      return { ...state, daemonHost: action.value };
    case 'set-project-path':
      return {
        ...state,
        projectPath: action.value,
        name: action.preserveName ? state.name : deriveProjectNameFromWorkspacePath(action.value),
      };
    case 'set-name':
      return { ...state, name: action.value };
    case 'reset':
      return initialCreateProjectDialogState;
    default:
      return state;
  }
}

export function CreateProjectDialog({ open, onClose }: CreateProjectDialogProps) {
  const [state, dispatch] = useReducer(createProjectDialogReducer, initialCreateProjectDialogState);
  const hasCustomNameRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const createProject = useProjectsStore((storeState) => storeState.createProject);
  const agents = useAgentsStore((storeState) => storeState.agents);
  const daemons = agents.filter((agent) => !agent.host.startsWith('conductor-fire-'));
  const hasDaemons = daemons.length > 0;
  const selectedDaemonHost = hasDaemons && daemons.some((daemon) => daemon.host === state.daemonHost.trim())
    ? state.daemonHost.trim()
    : hasDaemons
      ? daemons[0].host
      : state.daemonHost;
  const isSelectedDaemonOnline = daemons.some((daemon) => daemon.host === selectedDaemonHost.trim());

  const handleWorkspacePathChange = (value: string) => {
    dispatch({
      type: 'set-project-path',
      value,
      preserveName: hasCustomNameRef.current,
    });
  };

  const handleNameChange = (value: string) => {
    dispatch({ type: 'set-name', value });
    hasCustomNameRef.current = true;
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!state.name.trim()) return;

    setIsSubmitting(true);
    try {
      const trimmedProjectPath = state.projectPath.trim();
      const trimmedDaemonHost = selectedDaemonHost.trim();
      const payload: Record<string, unknown> = { name: state.name.trim() };
      if (trimmedDaemonHost && trimmedProjectPath && isSelectedDaemonOnline) {
        payload.daemonHost = trimmedDaemonHost;
        payload.workspacePath = trimmedProjectPath;
      } else if (trimmedDaemonHost && trimmedProjectPath) {
        payload.metadata = {
          bindingCandidate: {
            daemonHost: trimmedDaemonHost,
            workspacePath: trimmedProjectPath,
          },
        };
      }
      await createProject(payload as any);
      onClose();
      dispatch({ type: 'reset' });
      hasCustomNameRef.current = false;
    } catch {
      // Error handled by store
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Create Project">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label htmlFor="create-project-daemon-host" className="block text-sm font-medium mb-2">
            Daemon Host
          </label>
          {!hasDaemons ? (
            <input
              id="create-project-daemon-host"
              type="text"
              aria-label="Daemon host"
              value={state.daemonHost}
              onChange={(event) => dispatch({ type: 'set-daemon-host', value: event.target.value })}
              className="w-full webapp-input"
            />
          ) : (
            <select
              id="create-project-daemon-host"
              aria-label="Daemon host"
              value={selectedDaemonHost}
              onChange={(event) => dispatch({ type: 'set-daemon-host', value: event.target.value })}
              className="w-full webapp-input"
            >
              {daemons.map((daemon) => (
                <option key={daemon.id} value={daemon.host}>
                  {daemon.host}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label htmlFor="create-project-workspace-path" className="block text-sm font-medium mb-2">
            Workspace Path
          </label>
          <input
            id="create-project-workspace-path"
            type="text"
            aria-label="Workspace path"
            value={state.projectPath}
            onChange={(event) => handleWorkspacePathChange(event.target.value)}
            className="w-full webapp-input"
          />
        </div>

        <div>
          <label htmlFor="create-project-name" className="block text-sm font-medium mb-2">
            Name
          </label>
          <input
            id="create-project-name"
            type="text"
            aria-label="Project name"
            value={state.name}
            onChange={(event) => handleNameChange(event.target.value)}
            className="w-full webapp-input"
          />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 text-sm text-muted hover:text-ink hover:bg-border/30 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!state.name.trim() || isSubmitting}
            className="webapp-btn-primary px-5 py-2.5 text-sm"
          >
            {isSubmitting ? 'Creating...' : 'Create Project'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
