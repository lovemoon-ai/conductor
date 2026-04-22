'use client';

import { useEffect, useState } from 'react';
import type { Issue } from '@/shared/types';
import { Dialog } from '@/components/common/Dialog';

export function MoveIssueToDoingDialog({
  open,
  issue,
  availableBackends,
  initialBackend,
  onClose,
  onConfirm,
}: {
  open: boolean;
  issue: Issue | null;
  availableBackends: string[];
  initialBackend?: string | null;
  onClose: () => void;
  onConfirm: (backendType: string) => Promise<void> | void;
}) {
  const [backendType, setBackendType] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setBackendType('');
      setIsSubmitting(false);
      return;
    }

    const normalizedInitialBackend = typeof initialBackend === 'string' ? initialBackend.trim() : '';
    if (normalizedInitialBackend && availableBackends.includes(normalizedInitialBackend)) {
      setBackendType(normalizedInitialBackend);
      return;
    }

    setBackendType(availableBackends[0] ?? '');
  }, [availableBackends, initialBackend, open]);

  const handleClose = () => {
    if (isSubmitting) {
      return;
    }
    onClose();
  };

  const handleConfirm = async () => {
    if (!backendType || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    try {
      await onConfirm(backendType);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Move Issue To Doing"
      maxWidthClassName="max-w-lg"
    >
      <div className="space-y-5">
        <div className="space-y-1">
          <p className="text-sm font-medium text-ink">
            {issue?.title ?? 'Issue'}
          </p>
          <p className="text-sm text-muted">
            Starting this issue will create an AI task. Choose which backend should handle it.
          </p>
        </div>

        <div>
          <label htmlFor="issue-doing-backend" className="mb-2 block text-sm font-medium text-ink">
            Backend
          </label>
          <select
            id="issue-doing-backend"
            value={backendType}
            onChange={(event) => setBackendType(event.target.value)}
            className="w-full webapp-input"
            disabled={isSubmitting}
          >
            {availableBackends.map((backend) => (
              <option key={backend} value={backend}>
                {backend}
              </option>
            ))}
          </select>
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg px-4 py-2.5 text-sm text-muted transition-colors hover:bg-border/30 hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!backendType || isSubmitting}
            className="webapp-btn-primary px-5 py-2.5 text-sm"
          >
            {isSubmitting ? 'Starting...' : 'Move To Doing'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
