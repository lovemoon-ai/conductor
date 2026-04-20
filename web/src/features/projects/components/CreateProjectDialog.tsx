'use client';

import { useEffect, useState } from 'react';
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

export function CreateProjectDialog({ open, onClose }: CreateProjectDialogProps) {
  const [daemonHost, setDaemonHost] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [name, setName] = useState('');
  const [hasCustomName, setHasCustomName] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const createProject = useProjectsStore((state) => state.createProject);
  const agents = useAgentsStore((state) => state.agents);
  const daemons = agents.filter((agent) => !agent.host.startsWith('conductor-fire-'));
  const hasDaemons = daemons.length > 0;
  const isSelectedDaemonOnline = daemons.some((daemon) => daemon.host === daemonHost.trim());

  useEffect(() => {
    if (!hasDaemons) return;
    if (!isSelectedDaemonOnline) {
      setDaemonHost(daemons[0].host);
    }
  }, [daemonHost, daemons, hasDaemons, isSelectedDaemonOnline]);

  const handleWorkspacePathChange = (value: string) => {
    setProjectPath(value);
    if (!hasCustomName) {
      setName(deriveProjectNameFromWorkspacePath(value));
    }
  };

  const handleNameChange = (value: string) => {
    setName(value);
    setHasCustomName(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setIsSubmitting(true);
    try {
      const trimmedProjectPath = projectPath.trim();
      const trimmedDaemonHost = daemonHost.trim();
      const payload: Record<string, unknown> = { name: name.trim() };
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
      setName('');
      setProjectPath('');
      setDaemonHost('');
      setHasCustomName(false);
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
              value={daemonHost}
              onChange={(e) => setDaemonHost(e.target.value)}
              className="w-full webapp-input"
              autoFocus
            />
          ) : (
            <select
              id="create-project-daemon-host"
              value={daemonHost}
              onChange={(e) => setDaemonHost(e.target.value)}
              className="w-full webapp-input"
              autoFocus
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
            value={projectPath}
            onChange={(e) => handleWorkspacePathChange(e.target.value)}
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
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
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
            disabled={!name.trim() || isSubmitting}
            className="webapp-btn-primary px-5 py-2.5 text-sm"
          >
            {isSubmitting ? 'Creating...' : 'Create Project'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
