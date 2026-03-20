'use client';

interface InlineNoticeProps {
  variant?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  children: React.ReactNode;
  className?: string;
}

const variantClasses: Record<NonNullable<InlineNoticeProps['variant']>, string> = {
  info: 'border-accent/20 bg-accent/8 text-ink',
  success: 'border-[var(--success)]/20 bg-[var(--success)]/10 text-ink',
  warning: 'border-[var(--warning)]/20 bg-[var(--warning)]/10 text-ink',
  error: 'border-[var(--error)]/20 bg-[var(--error)]/10 text-ink',
};

const iconClasses: Record<NonNullable<InlineNoticeProps['variant']>, string> = {
  info: 'bg-accent',
  success: 'bg-[var(--success)]',
  warning: 'bg-[var(--warning)]',
  error: 'bg-[var(--error)]',
};

export function InlineNotice({
  variant = 'info',
  title,
  children,
  className = '',
}: InlineNoticeProps) {
  return (
    <div
      className={`rounded-2xl border px-4 py-3 ${variantClasses[variant]} ${className}`.trim()}
      role={variant === 'error' ? 'alert' : 'status'}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${iconClasses[variant]}`} aria-hidden="true" />
        <div className="min-w-0">
          {title ? <p className="text-sm font-semibold">{title}</p> : null}
          <div className={`text-sm ${title ? 'mt-1' : ''}`.trim()}>{children}</div>
        </div>
      </div>
    </div>
  );
}
