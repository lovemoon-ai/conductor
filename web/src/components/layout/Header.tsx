'use client';

import { ConnectionStatus } from '../common/ConnectionStatus';

interface HeaderProps {
  title?: string;
  showBack?: boolean;
  onBack?: () => void;
  actions?: React.ReactNode;
  showConnectionStatus?: boolean;
  compact?: boolean;
  connectionTaskId?: string | null;
  onTitleClick?: () => void;
  onTitleDoubleClick?: () => void;
  titleDoubleClickHint?: string;
}

const BackIcon = () => (
  <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
  </svg>
);

export function Header({
  title,
  showBack,
  onBack,
  actions,
  showConnectionStatus = false,
  compact = false,
  connectionTaskId,
  onTitleClick,
  onTitleDoubleClick,
  titleDoubleClickHint,
}: HeaderProps) {
  const isTitleInteractive = Boolean(onTitleClick || onTitleDoubleClick);

  return (
    <header className={`bg-panel border-b border-border flex items-center justify-between px-4 md:px-6 ${compact ? 'h-12' : 'h-16'}`}>
      <div className="flex items-center gap-4">
        {showBack && (
          <button type="button"
            onClick={onBack}
            className="p-2 -ml-2 hover:bg-[var(--border)]/50 rounded-lg transition-colors text-muted hover:text-ink"
          >
            <BackIcon />
          </button>
        )}
        {title && (
          <h2
            className={`text-lg md:text-xl font-semibold truncate ${
              isTitleInteractive ? 'select-none' : ''
            }`}
          >
            {isTitleInteractive ? (
              <button
                type="button"
                onClick={onTitleClick}
                onDoubleClick={onTitleDoubleClick}
                title={titleDoubleClickHint}
                className="block max-w-full truncate rounded bg-transparent p-0 text-left text-inherit"
              >
                {title}
              </button>
            ) : (
              title
            )}
          </h2>
        )}
      </div>

      <div className="flex items-center gap-4">
        <ConnectionStatus detailsEnabled={showConnectionStatus} taskId={connectionTaskId} />
        {actions}
      </div>
    </header>
  );
}
