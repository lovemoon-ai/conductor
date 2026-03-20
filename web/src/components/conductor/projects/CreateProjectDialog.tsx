'use client';

import { useState } from 'react';
import { Dialog } from '../common/Dialog';
import { useProjectsStore } from '@/lib/conductor/stores/projects';

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CreateProjectDialog({ open, onClose }: CreateProjectDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const createProject = useProjectsStore((state) => state.createProject);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setIsSubmitting(true);
    try {
      const trimmedProjectPath = projectPath.trim();
      const localPathHost = typeof window !== 'undefined' ? window.location.hostname || 'default' : 'default';
      const metadata = trimmedProjectPath
        ? {
            localPaths: {
              [localPathHost]: trimmedProjectPath,
              default: trimmedProjectPath,
            },
          }
        : undefined;

      await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        metadata,
      });
      onClose();
      setName('');
      setDescription('');
      setProjectPath('');
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
          <label className="block text-sm font-medium mb-2">Project Path</label>
          <input
            type="text"
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
            placeholder="Optional local path, e.g. /Users/you/ws/project"
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
