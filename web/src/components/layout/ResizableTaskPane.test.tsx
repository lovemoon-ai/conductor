import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ResizableTaskPane } from './ResizableTaskPane';

describe('ResizableTaskPane', () => {
  beforeEach(() => localStorage.clear());

  it('supports keyboard resizing and remembers the preference after remounting', () => {
    const view = render(<ResizableTaskPane>Tasks</ResizableTaskPane>);
    const separator = screen.getByRole('separator', { name: 'Task list width' });
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator).toHaveAttribute('aria-valuenow', '360');
    expect(localStorage.getItem('conductor-task-pane-width')).toBe('360');
    view.unmount();
    render(<ResizableTaskPane>Tasks</ResizableTaskPane>);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '360');
  });

  it('keeps keyboard resizing within the supported bounds', () => {
    render(<ResizableTaskPane>Tasks</ResizableTaskPane>);
    const separator = screen.getByRole('separator');
    fireEvent.keyDown(separator, { key: 'Home' });
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(separator).toHaveAttribute('aria-valuenow', '250');
    fireEvent.keyDown(separator, { key: 'End' });
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator).toHaveAttribute('aria-valuenow', '520');
  });

  it('recovers from an invalid saved preference', () => {
    localStorage.setItem('conductor-task-pane-width', 'NaN');
    render(<ResizableTaskPane>Tasks</ResizableTaskPane>);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '340');
  });
});
