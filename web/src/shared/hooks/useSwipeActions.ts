import { useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

interface UseSwipeActionsOptions {
  maxOffset: number;
  openThresholdRatio?: number;
  swipeStartThreshold?: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function useSwipeActions(options: UseSwipeActionsOptions) {
  const {
    maxOffset,
    openThresholdRatio = 0.45,
    swipeStartThreshold = 8,
  } = options;

  const [offset, setOffset] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const offsetRef = useRef(0);
  const draggingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const startXRef = useRef(0);
  const startOffsetRef = useRef(0);
  const didSwipeRef = useRef(false);

  const setOffsetValue = useCallback((value: number) => {
    offsetRef.current = value;
    setOffset(value);
  }, []);

  const closeActions = useCallback(() => {
    setOffsetValue(0);
    setIsOpen(false);
    didSwipeRef.current = false;
  }, [setOffsetValue]);

  // Open the actions without a drag, e.g. from a pointer-less trigger button.
  const openActions = useCallback(() => {
    const normalizedMax = Math.max(0, maxOffset);
    if (normalizedMax === 0) return;
    setOffsetValue(normalizedMax);
    setIsOpen(true);
    didSwipeRef.current = false;
  }, [maxOffset, setOffsetValue]);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!draggingRef.current || pointerIdRef.current !== event.pointerId) {
      return;
    }

    draggingRef.current = false;
    setIsDragging(false);

    const normalizedMax = Math.max(0, maxOffset);
    const shouldOpen = normalizedMax > 0 && offsetRef.current >= normalizedMax * openThresholdRatio;
    const targetOffset = shouldOpen ? normalizedMax : 0;

    setOffsetValue(targetOffset);
    setIsOpen(shouldOpen);
    pointerIdRef.current = null;

    const target = event.currentTarget as HTMLElement;
    if (typeof target.hasPointerCapture === 'function' && target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
  }, [maxOffset, openThresholdRatio, setOffsetValue]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const normalizedMax = Math.max(0, maxOffset);
    if (normalizedMax === 0) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    draggingRef.current = true;
    pointerIdRef.current = event.pointerId;
    startXRef.current = event.clientX;
    startOffsetRef.current = offsetRef.current;
    didSwipeRef.current = false;
    setIsDragging(true);

    const target = event.currentTarget as HTMLElement;
    if (typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // Ignore capture failures and continue with swipe logic.
      }
    }
  }, [maxOffset]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!draggingRef.current || pointerIdRef.current !== event.pointerId) {
      return;
    }

    const normalizedMax = Math.max(0, maxOffset);
    const delta = startXRef.current - event.clientX;
    const nextOffset = clamp(startOffsetRef.current + delta, 0, normalizedMax);
    if (Math.abs(nextOffset - startOffsetRef.current) > swipeStartThreshold) {
      didSwipeRef.current = true;
    }
    setOffsetValue(nextOffset);
  }, [maxOffset, setOffsetValue, swipeStartThreshold]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    endDrag(event);
  }, [endDrag]);

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    endDrag(event);
  }, [endDrag]);

  const consumeTap = useCallback(() => {
    if (didSwipeRef.current) {
      didSwipeRef.current = false;
      return true;
    }
    if (isOpen) {
      closeActions();
      return true;
    }
    return false;
  }, [closeActions, isOpen]);

  const panelStyle = useMemo<CSSProperties>(() => ({
    transform: `translateX(-${offset}px)`,
    transition: isDragging ? 'none' : 'transform 180ms ease',
    touchAction: 'pan-y',
  }), [isDragging, offset]);

  return {
    isOpen,
    panelStyle,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    closeActions,
    openActions,
    consumeTap,
  };
}
