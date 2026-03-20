'use client';

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  className = '',
}: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-panel/60 px-6 py-10 text-center ${className}`}>
      {icon ? <div className="text-muted/40">{icon}</div> : null}
      <h3 className="mt-4 text-lg font-semibold text-ink">{title}</h3>
      {description ? (
        <p className="mt-2 max-w-md text-sm text-muted/80">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
