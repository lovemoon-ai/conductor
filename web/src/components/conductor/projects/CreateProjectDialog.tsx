'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '../common/Dialog';
import { InlineNotice } from '../common/InlineNotice';
import { useProjectsStore } from '@/lib/conductor/stores/projects';
import { useAgentsStore } from '@/lib/conductor/stores/agents';

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CreateProjectDialog({ open, onClose }: CreateProjectDialogProps) {
  const [name, setName] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [daemonHost, setDaemonHost] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const createProject = useProjectsStore((state) => state.createProject);
  const agents = useAgentsStore((state) => state.agents);
  const daemons = agents.filter((agent) => !agent.host.startsWith('conductor-fire-'));
  const hasDaemons = daemons.length > 0;
  const isSelectedDaemonOnline = daemons.some((daemon) => daemon.host === daemonHost.trim());

  useEffect(() => {
    if (!daemonHost.trim() && hasDaemons) {
      setDaemonHost(daemons[0].host);
    }
  }, [daemonHost, daemons, hasDaemons]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !daemonHost.trim() || !projectPath.trim() || !isSelectedDaemonOnline) return;

    setIsSubmitting(true);
    try {
      const trimmedProjectPath = projectPath.trim();
      const trimmedDaemonHost = daemonHost.trim();
      await createProject({
        name: name.trim(),
        daemonHost: trimmedDaemonHost,
        workspacePath: trimmedProjectPath,
      });
      onClose();
      setName('');
      setProjectPath('');
      setDaemonHost('');
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
          <label className="block text-sm font-medium mb-2">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
            className="w-full webapp-input"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Daemon Host</label>
          <input
            type="text"
            value={daemonHost}
            onChange={(e) => setDaemonHost(e.target.value)}
            placeholder={hasDaemons ? 'Select an online daemon' : 'Reconnect a daemon first'}
            className="w-full webapp-input"
            list="daemon-host-options"
            disabled={!hasDaemons}
          />
          <datalist id="daemon-host-options">
            {daemons.map((daemon) => (
              <option key={daemon.id} value={daemon.host}>
                {daemon.host}
              </option>
            ))}
          </datalist>
          <InlineNotice variant="warning" className="mt-3">
            {hasDaemons
              ? 'Choose an online daemon. Conductor validates the workspace path immediately before creating the project.'
              : 'No daemon is online. Reconnect conductor daemon before creating a bound project.'}
          </InlineNotice>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Workspace Path</label>
          <input
            type="text"
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
            placeholder="Local path, e.g. /Users/you/ws/project"
            className="w-full webapp-input"
          />
          <p className="mt-2 text-xs text-muted">
            The selected daemon checks this path immediately. The project is created only after the daemon confirms it.
          </p>
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
            disabled={!name.trim() || !daemonHost.trim() || !projectPath.trim() || !isSelectedDaemonOnline || isSubmitting}
            className="webapp-btn-primary px-5 py-2.5 text-sm"
          >
            {isSubmitting ? 'Creating...' : 'Create Project'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
