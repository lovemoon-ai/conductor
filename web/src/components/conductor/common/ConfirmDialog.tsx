'use client';

import { Dialog } from './Dialog';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onCancel} title={title} description={description} maxWidthClassName="max-w-lg">
      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-paper hover:text-ink"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
            tone === 'danger'
              ? 'bg-[var(--error)] text-white hover:bg-[var(--error)]/90'
              : 'webapp-gradient-bg text-white hover:brightness-105'
          }`}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
