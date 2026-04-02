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
  const [description, setDescription] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [daemonHost, setDaemonHost] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const createProject = useProjectsStore((state) => state.createProject);
  const agents = useAgentsStore((state) => state.agents);
  const daemons = agents.filter((agent) => !agent.host.startsWith('conductor-fire-'));
  const hasDaemons = daemons.length > 0;

  useEffect(() => {
    if (!daemonHost.trim() && hasDaemons) {
      setDaemonHost(daemons[0].host);
    }
  }, [daemonHost, daemons, hasDaemons]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !daemonHost.trim() || !projectPath.trim()) return;

    setIsSubmitting(true);
    try {
      const trimmedProjectPath = projectPath.trim();
      const trimmedDaemonHost = daemonHost.trim();
      await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        metadata: {
          bindingCandidate: {
            daemonHost: trimmedDaemonHost,
            workspacePath: trimmedProjectPath,
          },
        },
      });
      onClose();
      setName('');
      setDescription('');
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
          <label className="block text-sm font-medium mb-2">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
            rows={3}
            className="w-full webapp-input resize-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Daemon Host</label>
          <input
            type="text"
            value={daemonHost}
            onChange={(e) => setDaemonHost(e.target.value)}
            placeholder={hasDaemons ? 'Select or enter daemon host' : 'Enter daemon host manually'}
            className="w-full webapp-input"
            list="daemon-host-options"
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
              ? 'Choose an online daemon or type another host. The daemon or CLI confirms the workspace binding later.'
              : 'No daemon is online. Enter the daemon host manually; the daemon or CLI confirms the workspace binding later.'}
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
            The daemon host and workspace path are saved as a candidate. The daemon or CLI confirms the binding later.
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
            disabled={!name.trim() || !daemonHost.trim() || !projectPath.trim() || isSubmitting}
            className="webapp-btn-primary px-5 py-2.5 text-sm"
          >
            {isSubmitting ? 'Creating...' : 'Create Project'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
