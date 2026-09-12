import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHorizontalSwipe } from './useHorizontalSwipe';

const onSwipeLeft = vi.fn();
const onSwipeRight = vi.fn();
const onProgress = vi.fn();

function SwipeSurface({ canStart }: { canStart?: () => boolean }) {
  const handlers = useHorizontalSwipe<HTMLDivElement>({ onSwipeLeft, onSwipeRight, onProgress, canStart });
  return (
    <div data-testid="surface" {...handlers}>
      <span>child</span>
    </div>
  );
}

const touchAt = (clientX: number, clientY: number) => ({
  pointerId: 1,
  pointerType: 'touch',
  clientX,
  clientY,
});

describe('useHorizontalSwipe', () => {
  beforeEach(() => {
    onSwipeLeft.mockReset();
    onSwipeRight.mockReset();
    onProgress.mockReset();
  });

  it('waits for clear horizontal movement before reporting progress', () => {
    render(<SwipeSurface />);
    const surface = screen.getByTestId('surface');

    fireEvent.pointerDown(surface, touchAt(200, 100));
    fireEvent.pointerMove(surface, touchAt(194, 104));
    expect(onProgress).not.toHaveBeenCalled();

    fireEvent.pointerMove(surface, touchAt(176, 104));
    expect(onProgress).toHaveBeenLastCalledWith({ progress: -0.25, direction: 'left', isDragging: true });

    fireEvent.pointerUp(surface, touchAt(140, 106));
    expect(onProgress).toHaveBeenLastCalledWith({ progress: 0, direction: null, isDragging: false });
    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
  });

  it('drops taps and vertical scrolls without reporting progress', () => {
    render(<SwipeSurface />);
    const surface = screen.getByTestId('surface');

    fireEvent.pointerDown(surface, touchAt(200, 100));
    fireEvent.pointerUp(surface, touchAt(203, 101));

    fireEvent.pointerDown(surface, touchAt(200, 100));
    fireEvent.pointerMove(surface, touchAt(190, 160));
    fireEvent.pointerUp(surface, touchAt(150, 170));

    expect(onProgress).not.toHaveBeenCalled();
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  it('ignores cancels that bubble from children without an active swipe', () => {
    render(<SwipeSurface />);

    fireEvent.pointerCancel(screen.getByText('child'), touchAt(200, 100));

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('resets progress when the browser cancels an active swipe', () => {
    render(<SwipeSurface />);
    const surface = screen.getByTestId('surface');

    fireEvent.pointerDown(surface, touchAt(200, 100));
    fireEvent.pointerMove(surface, touchAt(170, 102));
    fireEvent.pointerCancel(surface, touchAt(170, 102));

    expect(onProgress).toHaveBeenLastCalledWith({ progress: 0, direction: null, isDragging: false });
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  it('does not start when canStart rejects the pointer', () => {
    render(<SwipeSurface canStart={() => false} />);
    const surface = screen.getByTestId('surface');

    fireEvent.pointerDown(surface, touchAt(200, 100));
    fireEvent.pointerMove(surface, touchAt(150, 100));
    fireEvent.pointerUp(surface, touchAt(130, 100));

    expect(onProgress).not.toHaveBeenCalled();
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });
});
