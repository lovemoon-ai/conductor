'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/common/Dialog';
import { InlineNotice } from '@/components/common/InlineNotice';
import { useProjectsStore } from '../store';
import { useAgentsStore } from '@/features/agents';

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CreateProjectDialog({ open, onClose }: CreateProjectDialogProps) {
  const [name, setName] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [daemonHost, setDaemonHost] = useState('');
  const [manualMode, setManualMode] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const createProject = useProjectsStore((state) => state.createProject);
  const agents = useAgentsStore((state) => state.agents);
  const daemons = agents.filter((agent) => !agent.host.startsWith('conductor-fire-'));
  const hasDaemons = daemons.length > 0;
  const isSelectedDaemonOnline = daemons.some((daemon) => daemon.host === daemonHost.trim());

  // Auto-select the first online daemon when the dropdown is in select mode
  // and nothing has been chosen yet. Skipped in manual mode so the user can
  // freely type an offline daemon host for later binding.
  useEffect(() => {
    if (manualMode) return;
    if (!daemonHost.trim() && hasDaemons) {
      setDaemonHost(daemons[0].host);
    }
  }, [manualMode, daemonHost, daemons, hasDaemons]);

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
      setManualMode(false);
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
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium">Daemon Host</label>
            {hasDaemons && (
              <button
                type="button"
                onClick={() => {
                  const next = !manualMode;
                  setManualMode(next);
                  // When switching back to select mode, snap to the first
                  // online daemon if the current value is not in the list.
                  if (!next && !daemons.some((d) => d.host === daemonHost.trim())) {
                    setDaemonHost(daemons[0].host);
                  }
                }}
                className="text-xs text-muted hover:text-ink underline"
              >
                {manualMode ? 'Pick from online daemons' : 'Enter host manually'}
              </button>
            )}
          </div>
          {manualMode || !hasDaemons ? (
            <input
              type="text"
              value={daemonHost}
              onChange={(e) => setDaemonHost(e.target.value)}
              placeholder={hasDaemons ? 'Type a daemon host' : 'Reconnect a daemon first'}
              className="w-full webapp-input"
            />
          ) : (
            <select
              value={daemonHost}
              onChange={(e) => setDaemonHost(e.target.value)}
              className="w-full webapp-input"
            >
              {daemons.map((daemon) => (
                <option key={daemon.id} value={daemon.host}>
                  {daemon.host}
                </option>
              ))}
            </select>
          )}
          <InlineNotice variant="warning" className="mt-3">
            {!hasDaemons
              ? 'No daemon is online. Reconnect conductor daemon before creating a bound project.'
              : manualMode
                ? isSelectedDaemonOnline
                  ? 'This daemon is online. Conductor validates the workspace path immediately before creating the project.'
                  : 'This daemon is not online right now. The project will be saved as a binding candidate and bound when the daemon reconnects.'
                : 'Choose an online daemon. Conductor validates the workspace path immediately before creating the project.'}
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
