import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Header } from './Header';

vi.mock('../common/ConnectionStatus', () => ({
  ConnectionStatus: () => null,
}));

describe('Header', () => {
  const onSwipeLeft = vi.fn();
  const onSwipeRight = vi.fn();
  const onTitleClick = vi.fn();

  beforeEach(() => {
    onSwipeLeft.mockReset();
    onSwipeRight.mockReset();
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
});
