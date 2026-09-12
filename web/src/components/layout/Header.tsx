'use client';

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import Link from 'next/link';
import { getSwipeDirection, useHorizontalSwipe, type HorizontalSwipeProgress } from '@/shared/hooks/useHorizontalSwipe';
import { ConnectionStatus } from '../common/ConnectionStatus';

export type TitleSwipeProgress = HorizontalSwipeProgress;

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
  onTitleSwipeLeft?: () => void;
  onTitleSwipeRight?: () => void;
  onTitleSwipeProgress?: (state: TitleSwipeProgress) => void;
  titleSwipePreviewLeft?: string | null;
  titleSwipePreviewRight?: string | null;
  /** Swipe state owned by the page; overrides the title's own drag so other surfaces can drive the preview. */
  titleSwipeState?: Pick<TitleSwipeProgress, 'progress' | 'isDragging'>;
  titleTransitionDirection?: 'forward' | 'backward' | null;
  titleDoubleClickHint?: string;
}

const TITLE_SWIPE_CURRENT_OFFSET_PX = 28;
const TITLE_SWIPE_PREVIEW_OFFSET_PX = 34;

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
  onTitleSwipeLeft,
  onTitleSwipeRight,
  onTitleSwipeProgress,
  titleSwipePreviewLeft,
  titleSwipePreviewRight,
  titleSwipeState,
  titleTransitionDirection,
  titleDoubleClickHint,
}: HeaderProps) {
  const [localTitleSwipeProgress, setTitleSwipeProgress] = useState(0);
  const [isLocalTitleSwipeTracking, setIsTitleSwipeTracking] = useState(false);
  const titleSwipeProgress = titleSwipeState ? titleSwipeState.progress : localTitleSwipeProgress;
  const isTitleSwipeTracking = titleSwipeState ? titleSwipeState.isDragging : isLocalTitleSwipeTracking;
  const titleDidSwipeRef = useRef(false);
  const titleSwipeClickResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTitleSwipeEnabled = Boolean(onTitleSwipeLeft || onTitleSwipeRight);
  const isTitleInteractive = Boolean(onTitleClick || onTitleDoubleClick || isTitleSwipeEnabled);
  const titleTransitionClassName = titleTransitionDirection
    ? `webapp-title-switch-${titleTransitionDirection}`
    : '';
  const titleSwipeAbsProgress = Math.abs(titleSwipeProgress);
  const titleSwipeDirection = getSwipeDirection(titleSwipeProgress);
  const titleSwipePreview =
    titleSwipeDirection === 'left'
      ? titleSwipePreviewRight
      : titleSwipeDirection === 'right'
        ? titleSwipePreviewLeft
        : null;
  const titleSwipeCurrentStyle: CSSProperties | undefined = titleSwipeProgress !== 0
    ? {
        opacity: 1 - titleSwipeAbsProgress * 0.36,
        transform: `translateX(${titleSwipeProgress * TITLE_SWIPE_CURRENT_OFFSET_PX}px)`,
      }
    : undefined;
  const titleSwipePreviewStyle: CSSProperties | undefined = titleSwipePreview && titleSwipeDirection
    ? {
        opacity: Math.min(1, titleSwipeAbsProgress * 1.15),
        transform: `translateX(${
          (titleSwipeDirection === 'left' ? 1 : -1)
          * (1 - titleSwipeAbsProgress)
          * TITLE_SWIPE_PREVIEW_OFFSET_PX
        }px)`,
      }
    : undefined;
  const titleSwipeLayerClassName = `webapp-title-swipe-layer ${
    isTitleSwipeTracking ? 'webapp-title-swipe-layer-dragging' : ''
  }`;
  const titleContent = title ? (
    isTitleInteractive ? (
      <span className="relative block max-w-full overflow-hidden">
        <span
          key={`${title}-${titleTransitionDirection ?? 'idle'}`}
          className={`block max-w-full truncate ${titleTransitionClassName} ${titleSwipeLayerClassName}`}
          style={titleSwipeCurrentStyle}
        >
          {title}
        </span>
        {titleSwipePreview ? (
          <span
            aria-hidden="true"
            className={`absolute inset-0 block max-w-full truncate ${titleSwipeLayerClassName}`}
            style={titleSwipePreviewStyle}
          >
            {titleSwipePreview}
          </span>
        ) : null}
      </span>
    ) : (
      <span
        key={`${title}-${titleTransitionDirection ?? 'idle'}`}
        className={`block max-w-full truncate ${titleTransitionClassName}`}
      >
        {title}
      </span>
    )
  ) : null;

  // A completed swipe must swallow the click the browser synthesizes after it.
  const withTitleSwipeClickGuard = (handler?: () => void) => handler && (() => {
    titleDidSwipeRef.current = true;
    if (titleSwipeClickResetTimeoutRef.current !== null) {
      clearTimeout(titleSwipeClickResetTimeoutRef.current);
    }
    titleSwipeClickResetTimeoutRef.current = setTimeout(() => {
      titleDidSwipeRef.current = false;
      titleSwipeClickResetTimeoutRef.current = null;
    }, 0);
    handler();
  });
  const titleSwipeHandlers = useHorizontalSwipe<HTMLButtonElement>({
    onSwipeLeft: withTitleSwipeClickGuard(onTitleSwipeLeft),
    onSwipeRight: withTitleSwipeClickGuard(onTitleSwipeRight),
    onProgress: (state) => {
      setTitleSwipeProgress(state.progress);
      setIsTitleSwipeTracking(state.isDragging);
      onTitleSwipeProgress?.(state);
    },
  });

  useEffect(() => (
    () => {
      if (titleSwipeClickResetTimeoutRef.current !== null) {
        clearTimeout(titleSwipeClickResetTimeoutRef.current);
      }
    }
  ), []);

  const handleTitleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (titleDidSwipeRef.current) {
      titleDidSwipeRef.current = false;
      if (titleSwipeClickResetTimeoutRef.current !== null) {
        clearTimeout(titleSwipeClickResetTimeoutRef.current);
        titleSwipeClickResetTimeoutRef.current = null;
      }
      event.preventDefault();
      return;
    }
    onTitleClick?.();
  };

  return (
    <header className={`bg-panel border-b border-border flex shrink-0 items-center justify-between gap-3 px-4 md:px-6 ${compact ? 'h-14 md:h-16' : 'h-16'}`}>
      <div className="flex min-w-0 items-center gap-4">
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
            className={`min-w-0 text-lg md:text-xl font-semibold truncate ${
              isTitleInteractive ? 'select-none' : ''
            }`}
          >
            {isTitleInteractive ? (
              <button
                type="button"
                onClick={handleTitleClick}
                onDoubleClick={onTitleDoubleClick}
                {...titleSwipeHandlers}
                title={titleDoubleClickHint}
                className="block min-w-0 max-w-full overflow-hidden truncate rounded bg-transparent p-0 text-left text-inherit"
                style={isTitleSwipeEnabled ? { touchAction: 'pan-y' } : undefined}
              >
                {titleContent}
              </button>
            ) : (
              titleContent
            )}
          </h2>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-4">
        <ConnectionStatus detailsEnabled={showConnectionStatus} taskId={connectionTaskId} />
        <Link href="/app/search" aria-label="Search messages" title="Search messages (⌘K / Ctrl+K)" className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-paper md:hidden">
          <svg aria-hidden="true" className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
        </Link>
        {actions}
      </div>
    </header>
  );
}
