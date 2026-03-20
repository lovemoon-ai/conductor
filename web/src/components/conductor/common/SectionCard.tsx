'use client';

interface SectionCardProps {
  title?: string;
  description?: string;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}

export function SectionCard({
  title,
  description,
  headerAction,
  children,
  className = '',
  contentClassName = '',
}: SectionCardProps) {
  return (
    <section className={`webapp-card ${className}`}>
      {title || description || headerAction ? (
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            {title ? <h2 className="text-lg font-semibold text-ink">{title}</h2> : null}
            {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
          </div>
          {headerAction}
        </div>
      ) : null}
      <div className={`p-5 ${contentClassName}`}>{children}</div>
    </section>
  );
}
