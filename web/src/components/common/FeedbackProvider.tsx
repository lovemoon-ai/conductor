'use client';

import { createContext, use, useCallback, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { Toast, type ToastItem, type ToastVariant } from './Toast';

interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
}

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

interface FeedbackContextValue {
  pushToast: (input: ToastInput) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

const TOAST_DURATION_MS = 3200;

export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<(ConfirmOptions & { open: boolean }) | null>(null);
  const confirmResolverRef = useRef<((value: boolean) => void) | null>(null);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((input: ToastInput) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nextToast: ToastItem = {
      id,
      title: input.title,
      description: input.description,
      variant: input.variant ?? 'info',
    };
    setToasts((current) => [...current, nextToast]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_DURATION_MS);
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    confirmResolverRef.current = resolve;
    setConfirmState({ ...options, open: true });
  }), []);

  const resolveConfirm = useCallback((accepted: boolean) => {
    confirmResolverRef.current?.(accepted);
    confirmResolverRef.current = null;
    setConfirmState(null);
  }, []);

  const contextValue = useMemo<FeedbackContextValue>(() => ({
    pushToast,
    confirm,
  }), [confirm, pushToast]);

  return (
    <FeedbackContext.Provider value={contextValue}>
      {children}

      <div className="pointer-events-none fixed inset-x-0 top-4 z-[100] flex flex-col items-center gap-3 px-4">
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto">
            <Toast toast={toast} onDismiss={dismissToast} />
          </div>
        ))}
      </div>

      {confirmState ? (
        <ConfirmDialog
          open={confirmState.open}
          title={confirmState.title}
          description={confirmState.description}
          confirmLabel={confirmState.confirmLabel}
          cancelLabel={confirmState.cancelLabel}
          tone={confirmState.tone}
          onConfirm={() => resolveConfirm(true)}
          onCancel={() => resolveConfirm(false)}
        />
      ) : null}
    </FeedbackContext.Provider>
  );
}

export function useToast() {
  const context = use(FeedbackContext);

  return useMemo(() => ({
    pushToast: (input: ToastInput) => {
      if (context) {
        context.pushToast(input);
        return;
      }
      if (typeof window !== 'undefined') {
        window.alert(input.description ? `${input.title}\n\n${input.description}` : input.title);
      }
    },
  }), [context]);
}

export function useConfirm() {
  const context = use(FeedbackContext);

  return useMemo(() => ({
    confirm: async (options: ConfirmOptions) => {
      if (context) {
        return context.confirm(options);
      }
      if (typeof window !== 'undefined') {
        return window.confirm(options.description ? `${options.title}\n\n${options.description}` : options.title);
      }
      return false;
    },
  }), [context]);
}
