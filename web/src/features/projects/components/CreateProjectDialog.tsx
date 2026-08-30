'use client';

import { useReducer, useRef, useState } from 'react';
import { Dialog } from '@/components/common/Dialog';
import { ApiRequestError } from '@/shared/api/client';
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
  // Set when the daemon reports the workspace path is missing, so the user can
  // confirm creating it instead of having a typo'd path silently materialize.
  const [missingWorkspacePath, setMissingWorkspacePath] = useState<string | null>(null);

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

  // "Missing" is a claim about one daemon's filesystem, so it must not survive a
  // change to either the path or the daemon it was validated against.
  const handleDaemonHostChange = (value: string) => {
    setMissingWorkspacePath(null);
    dispatch({ type: 'set-daemon-host', value });
  };

  const handleWorkspacePathChange = (value: string) => {
    setMissingWorkspacePath(null);
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

  const submitCreate = async (createWorkspaceIfMissing: boolean) => {
    if (!state.name.trim()) return;

    setIsSubmitting(true);
    try {
      const trimmedProjectPath = state.projectPath.trim();
      const trimmedDaemonHost = selectedDaemonHost.trim();
      const payload: Record<string, unknown> = { name: state.name.trim() };
      if (trimmedDaemonHost && trimmedProjectPath && isSelectedDaemonOnline) {
        payload.daemonHost = trimmedDaemonHost;
        payload.workspacePath = trimmedProjectPath;
        if (createWorkspaceIfMissing) {
          payload.createWorkspaceIfMissing = true;
        }
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
      setMissingWorkspacePath(null);
      hasCustomNameRef.current = false;
    } catch (error) {
      // Offer to create the directory instead of dead-ending on "does not exist".
      if (error instanceof ApiRequestError && error.payload?.code === 'workspace_not_found') {
        setMissingWorkspacePath(state.projectPath.trim());
      } else {
        setMissingWorkspacePath(null);
      }
      // Other errors are surfaced by the store.
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    await submitCreate(false);
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
              onChange={(event) => handleDaemonHostChange(event.target.value)}
              className="w-full webapp-input"
            />
          ) : (
            <select
              id="create-project-daemon-host"
              aria-label="Daemon host"
              value={selectedDaemonHost}
              onChange={(event) => handleDaemonHostChange(event.target.value)}
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
          {missingWorkspacePath && (
            <div
              role="alert"
              className="mt-2 rounded-lg border border-border bg-border/20 px-3 py-2.5 text-sm"
            >
              <p className="text-muted">
                <span className="font-mono break-all text-ink">{missingWorkspacePath}</span>{' '}
                does not exist on {selectedDaemonHost}.
              </p>
              <button
                type="button"
                onClick={() => submitCreate(true)}
                disabled={isSubmitting}
                className="mt-2 text-sm font-medium text-accent hover:underline disabled:opacity-50"
              >
                {isSubmitting ? 'Creating directory...' : 'Create this directory and continue'}
              </button>
            </div>
          )}
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
