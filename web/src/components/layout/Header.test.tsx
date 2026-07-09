import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Header } from './Header';

vi.mock('../common/ConnectionStatus', () => ({
  ConnectionStatus: () => null,
}));

describe('Header', () => {
  const onSwipeLeft = vi.fn();
  const onSwipeRight = vi.fn();
  const onSwipeProgress = vi.fn();
  const onTitleClick = vi.fn();

  beforeEach(() => {
    onSwipeLeft.mockReset();
    onSwipeRight.mockReset();
    onSwipeProgress.mockReset();
    onTitleClick.mockReset();
  });

  it('calls the left swipe handler for a horizontal title swipe', () => {
    render(<Header title="Project A" onTitleSwipeLeft={onSwipeLeft} />);

    const title = screen.getByRole('button', { name: 'Project A' });
    fireEvent.pointerDown(title, { pointerId: 1, pointerType: 'touch', clientX: 220, clientY: 20 });
    fireEvent.pointerUp(title, { pointerId: 1, pointerType: 'touch', clientX: 150, clientY: 24 });

    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('calls the right swipe handler for a horizontal title swipe', () => {
    render(<Header title="Project A" onTitleSwipeRight={onSwipeRight} />);

    const title = screen.getByRole('button', { name: 'Project A' });
    fireEvent.pointerDown(title, { pointerId: 1, pointerType: 'touch', clientX: 120, clientY: 20 });
    fireEvent.pointerUp(title, { pointerId: 1, pointerType: 'touch', clientX: 190, clientY: 24 });

    expect(onSwipeRight).toHaveBeenCalledTimes(1);
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  it('ignores mostly vertical title movement', () => {
    render(
      <Header
        title="Project A"
        onTitleSwipeLeft={onSwipeLeft}
        onTitleSwipeRight={onSwipeRight}
      />,
    );

    const title = screen.getByRole('button', { name: 'Project A' });
    fireEvent.pointerDown(title, { pointerId: 1, pointerType: 'touch', clientX: 220, clientY: 20 });
    fireEvent.pointerUp(title, { pointerId: 1, pointerType: 'touch', clientX: 150, clientY: 80 });

    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it('reports title swipe progress and shows the target preview while dragging', () => {
    render(
      <Header
        title="Project A"
        onTitleSwipeLeft={onSwipeLeft}
        onTitleSwipeProgress={onSwipeProgress}
        titleSwipePreviewRight="Project B"
      />,
    );

    const title = screen.getByRole('button', { name: 'Project A' });
    fireEvent.pointerDown(title, { pointerId: 1, pointerType: 'touch', clientX: 220, clientY: 20 });
    fireEvent.pointerMove(title, { pointerId: 1, pointerType: 'touch', clientX: 172, clientY: 22 });

    const latestProgress = onSwipeProgress.mock.calls.at(-1)?.[0];
    expect(latestProgress).toMatchObject({
      direction: 'left',
      isDragging: true,
    });
    expect(latestProgress?.progress).toBeCloseTo(-0.5);
    expect(screen.getByText('Project A')).toHaveStyle('transform: translateX(-14px)');
    expect(screen.getByText('Project B')).toBeInTheDocument();
  });

  it('does not forward the synthetic click after a title swipe', () => {
    render(
      <Header
        title="Project A"
        onTitleClick={onTitleClick}
        onTitleSwipeLeft={onSwipeLeft}
      />,
    );

    const title = screen.getByRole('button', { name: 'Project A' });
    fireEvent.pointerDown(title, { pointerId: 1, pointerType: 'touch', clientX: 220, clientY: 20 });
    fireEvent.pointerUp(title, { pointerId: 1, pointerType: 'touch', clientX: 150, clientY: 24 });
    fireEvent.click(title);

    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(onTitleClick).not.toHaveBeenCalled();
  });

  it('does not treat an unavailable swipe direction as a handled title swipe', () => {
    render(
      <Header
        title="Project A"
        onTitleClick={onTitleClick}
        onTitleSwipeLeft={onSwipeLeft}
      />,
    );

    const title = screen.getByRole('button', { name: 'Project A' });
    fireEvent.pointerDown(title, { pointerId: 1, pointerType: 'touch', clientX: 120, clientY: 20 });
    fireEvent.pointerUp(title, { pointerId: 1, pointerType: 'touch', clientX: 190, clientY: 24 });
    fireEvent.click(title);

    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onTitleClick).toHaveBeenCalledTimes(1);
  });

  it('applies the requested title transition direction', () => {
    render(<Header title="Project A" titleTransitionDirection="forward" />);

    expect(screen.getByText('Project A')).toHaveClass('webapp-title-switch-forward');
  });
});
