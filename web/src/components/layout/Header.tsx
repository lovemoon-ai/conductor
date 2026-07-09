'use client';

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ConnectionStatus } from '../common/ConnectionStatus';

export interface TitleSwipeProgress {
  progress: number;
  direction: 'left' | 'right' | null;
  isDragging: boolean;
}

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
  titleTransitionDirection?: 'forward' | 'backward' | null;
  titleDoubleClickHint?: string;
}

const TITLE_SWIPE_DISTANCE_PX = 48;
const TITLE_SWIPE_FULL_DISTANCE_PX = 96;
const TITLE_SWIPE_CURRENT_OFFSET_PX = 28;
const TITLE_SWIPE_PREVIEW_OFFSET_PX = 34;
const TITLE_SWIPE_VERTICAL_TOLERANCE_PX = 32;

const clampTitleSwipeProgress = (progress: number) =>
  Math.max(-1, Math.min(1, progress));

const getTitleSwipeDirection = (progress: number): TitleSwipeProgress['direction'] => {
  if (progress < 0) return 'left';
  if (progress > 0) return 'right';
  return null;
};

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
  titleTransitionDirection,
  titleDoubleClickHint,
}: HeaderProps) {
  const [titleSwipeProgress, setTitleSwipeProgress] = useState(0);
  const [isTitleSwipeTracking, setIsTitleSwipeTracking] = useState(false);
  const titleSwipeGestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const titleDidSwipeRef = useRef(false);
  const titleSwipeClickResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTitleSwipeEnabled = Boolean(onTitleSwipeLeft || onTitleSwipeRight);
  const isTitleInteractive = Boolean(onTitleClick || onTitleDoubleClick || isTitleSwipeEnabled);
  const titleTransitionClassName = titleTransitionDirection
    ? `webapp-title-switch-${titleTransitionDirection}`
    : '';
  const titleSwipeAbsProgress = Math.abs(titleSwipeProgress);
  const titleSwipeDirection = getTitleSwipeDirection(titleSwipeProgress);
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

  const updateTitleSwipeProgress = (nextProgress: number, isDragging: boolean) => {
    const progress = clampTitleSwipeProgress(nextProgress);
    setTitleSwipeProgress(progress);
    setIsTitleSwipeTracking(isDragging);
    onTitleSwipeProgress?.({
      progress,
      direction: getTitleSwipeDirection(progress),
      isDragging,
    });
  };

  useEffect(() => (
    () => {
      if (titleSwipeClickResetTimeoutRef.current !== null) {
        clearTimeout(titleSwipeClickResetTimeoutRef.current);
      }
    }
  ), []);

  const handleTitlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!isTitleSwipeEnabled) {
      return;
    }
    if (event.pointerType === 'mouse') {
      return;
    }
    titleSwipeGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    updateTitleSwipeProgress(0, true);

    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture can fail if the browser has already cancelled it.
      }
    }
  };

  const handleTitlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = titleSwipeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);
    if (absDeltaY > TITLE_SWIPE_VERTICAL_TOLERANCE_PX && absDeltaY > absDeltaX) {
      titleSwipeGestureRef.current = null;
      releaseTitlePointer(event);
      updateTitleSwipeProgress(0, false);
      return;
    }

    let progress = clampTitleSwipeProgress(deltaX / TITLE_SWIPE_FULL_DISTANCE_PX);
    if ((progress < 0 && !onTitleSwipeLeft) || (progress > 0 && !onTitleSwipeRight)) {
      progress = 0;
    }
    updateTitleSwipeProgress(progress, true);
    if (progress !== 0) {
      event.preventDefault();
    }
  };

  const releaseTitlePointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (
      typeof event.currentTarget.hasPointerCapture === 'function'
      && event.currentTarget.hasPointerCapture(event.pointerId)
      && typeof event.currentTarget.releasePointerCapture === 'function'
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleTitlePointerEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = titleSwipeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    titleSwipeGestureRef.current = null;
    releaseTitlePointer(event);
    updateTitleSwipeProgress(0, false);

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (
      Math.abs(deltaX) < TITLE_SWIPE_DISTANCE_PX
      || Math.abs(deltaY) > TITLE_SWIPE_VERTICAL_TOLERANCE_PX
    ) {
      return;
    }

    const swipeHandler = deltaX < 0 ? onTitleSwipeLeft : onTitleSwipeRight;
    if (!swipeHandler) {
      return;
    }

    titleDidSwipeRef.current = true;
    if (titleSwipeClickResetTimeoutRef.current !== null) {
      clearTimeout(titleSwipeClickResetTimeoutRef.current);
    }
    titleSwipeClickResetTimeoutRef.current = setTimeout(() => {
      titleDidSwipeRef.current = false;
      titleSwipeClickResetTimeoutRef.current = null;
    }, 0);
    event.preventDefault();
    swipeHandler();
  };

  const handleTitlePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    titleSwipeGestureRef.current = null;
    releaseTitlePointer(event);
    updateTitleSwipeProgress(0, false);
  };

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
    <header className={`bg-panel border-b border-border flex items-center justify-between px-4 md:px-6 ${compact ? 'h-12' : 'h-16'}`}>
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
                onPointerDown={handleTitlePointerDown}
                onPointerMove={handleTitlePointerMove}
                onPointerUp={handleTitlePointerEnd}
                onPointerCancel={handleTitlePointerCancel}
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

      <div className="flex items-center gap-4">
        <ConnectionStatus detailsEnabled={showConnectionStatus} taskId={connectionTaskId} />
        {actions}
      </div>
    </header>
  );
}
