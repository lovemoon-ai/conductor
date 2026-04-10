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
  onTitleDoubleClick?: () => void;
  titleDoubleClickHint?: string;
}

const BackIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
  onTitleDoubleClick,
  titleDoubleClickHint,
}: HeaderProps) {
  return (
    <header className={`bg-panel border-b border-border flex items-center justify-between px-4 md:px-6 ${compact ? 'h-12' : 'h-16'}`}>
      <div className="flex items-center gap-4">
        {showBack && (
          <button
            onClick={onBack}
            className="p-2 -ml-2 hover:bg-[var(--border)]/50 rounded-lg transition-colors text-muted hover:text-ink"
          >
            <BackIcon />
          </button>
        )}
        {title && (
          <h2
            onDoubleClick={onTitleDoubleClick}
            title={titleDoubleClickHint}
            className={`text-lg md:text-xl font-semibold truncate ${
              onTitleDoubleClick ? 'select-none cursor-default' : ''
            }`}
          >
            {title}
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
