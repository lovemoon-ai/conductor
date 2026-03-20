'use client';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant?: ToastVariant;
}

interface ToastProps {
  toast: ToastItem;
  onDismiss: (id: string) => void;
}

const variantClassMap: Record<ToastVariant, string> = {
  info: 'border-border text-ink',
  success: 'border-[var(--success)]/25 text-ink',
  warning: 'border-[var(--warning)]/25 text-ink',
  error: 'border-[var(--error)]/25 text-ink',
};

export function Toast({ toast, onDismiss }: ToastProps) {
  const variant = toast.variant ?? 'info';

  return (
    <div className={`webapp-card w-full max-w-sm p-4 ${variantClassMap[variant]}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">{toast.title}</p>
          {toast.description ? (
            <p className="mt-1 text-sm text-muted">{toast.description}</p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(toast.id)}
          className="rounded-lg p-1 text-muted transition-colors hover:bg-border/30 hover:text-ink"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
