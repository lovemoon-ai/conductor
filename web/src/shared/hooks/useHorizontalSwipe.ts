import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

export interface HorizontalSwipeProgress {
  progress: number;
  direction: 'left' | 'right' | null;
  isDragging: boolean;
}

interface UseHorizontalSwipeOptions<T extends Element> {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onProgress?: (state: HorizontalSwipeProgress) => void;
  /** Return false to leave the pointer to another gesture owner. */
  canStart?: (event: ReactPointerEvent<T>) => boolean;
}

type SwipeGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  /** Set once movement turns clearly horizontal; progress is reported only after that. */
  tracking: boolean;
};

const SWIPE_START_THRESHOLD_PX = 8;
const SWIPE_DISTANCE_PX = 48;
const SWIPE_FULL_DISTANCE_PX = 96;
const SWIPE_VERTICAL_TOLERANCE_PX = 32;

export const getSwipeDirection = (progress: number): HorizontalSwipeProgress['direction'] => {
  if (progress < 0) return 'left';
  if (progress > 0) return 'right';
  return null;
};

/**
 * Non-mouse horizontal swipe: reports drag progress in [-1, 1] and fires the
 * matching handler when released past the distance threshold. Progress is only
 * reported once movement turns clearly horizontal, so taps and vertical scrolls
 * that start on the element never re-render its owner. Pair the element with
 * `touch-action: pan-y` so the browser does not cancel horizontal drags.
 */
export function useHorizontalSwipe<T extends Element>({
  onSwipeLeft,
  onSwipeRight,
  onProgress,
  canStart,
}: UseHorizontalSwipeOptions<T>) {
  const gestureRef = useRef<SwipeGesture | null>(null);

  const reportProgress = (nextProgress: number, isDragging: boolean) => {
    const progress = Math.max(-1, Math.min(1, nextProgress));
    onProgress?.({ progress, direction: getSwipeDirection(progress), isDragging });
  };

  const endGesture = (event: ReactPointerEvent<T>, gesture: SwipeGesture) => {
    gestureRef.current = null;
    if (
      typeof event.currentTarget.hasPointerCapture === 'function'
      && event.currentTarget.hasPointerCapture(event.pointerId)
      && typeof event.currentTarget.releasePointerCapture === 'function'
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (gesture.tracking) {
      reportProgress(0, false);
    }
  };

  const onPointerDown = (event: ReactPointerEvent<T>) => {
    if ((!onSwipeLeft && !onSwipeRight) || event.pointerType === 'mouse') {
      return;
    }
    if (canStart && !canStart(event)) {
      return;
    }
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      tracking: false,
    };

    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture can fail if the browser has already cancelled it.
      }
    }
  };

  const onPointerMove = (event: ReactPointerEvent<T>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);
    if (absDeltaY > SWIPE_VERTICAL_TOLERANCE_PX && absDeltaY > absDeltaX) {
      endGesture(event, gesture);
      return;
    }
    if (!gesture.tracking) {
      if (absDeltaX <= SWIPE_START_THRESHOLD_PX || absDeltaX <= absDeltaY) {
        return;
      }
      gesture.tracking = true;
    }

    let progress = deltaX / SWIPE_FULL_DISTANCE_PX;
    if ((progress < 0 && !onSwipeLeft) || (progress > 0 && !onSwipeRight)) {
      progress = 0;
    }
    reportProgress(progress, true);
    if (progress !== 0) {
      event.preventDefault();
    }
  };

  const onPointerUp = (event: ReactPointerEvent<T>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    endGesture(event, gesture);

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (
      Math.abs(deltaX) < SWIPE_DISTANCE_PX
      || Math.abs(deltaY) > SWIPE_VERTICAL_TOLERANCE_PX
    ) {
      return;
    }

    const swipeHandler = deltaX < 0 ? onSwipeLeft : onSwipeRight;
    if (!swipeHandler) {
      return;
    }

    event.preventDefault();
    swipeHandler();
  };

  // Cancels bubbling from children that never started a swipe (e.g. a card
  // handing its touch to native scroll) are ignored.
  const onPointerCancel = (event: ReactPointerEvent<T>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    endGesture(event, gesture);
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
