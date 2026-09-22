import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadingSettings, TaskColumnSettings } from './WorkspaceControls';
import { useReadingSize, useTaskColumns } from './preferences';

function State() {
  const [size] = useReadingSize();
  const [columns] = useTaskColumns();
  return <div data-testid="settings">{size ?? 'auto'}:{columns.join(',')}</div>;
}
describe('workspace preferences', () => {
  beforeEach(() => {
    localStorage.setItem('conductor-reading-size', 'auto');
    localStorage.setItem('conductor-task-columns', JSON.stringify(['preview', 'backend', 'host']));
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
  });
  it('updates all readers, persists size, bounds it and resets to responsive defaults', () => {
    const view = render(<><ReadingSettings /><State /></>);
    fireEvent.click(screen.getByLabelText('Increase text size'));
    expect(screen.getByTestId('settings')).toHaveTextContent('15:');
    expect(localStorage.getItem('conductor-reading-size')).toBe('15');
    for (let i = 0; i < 12; i++) fireEvent.click(screen.getByLabelText('Increase text size'));
    expect(screen.getByLabelText('Increase text size')).toBeDisabled();
    view.unmount();
    render(<><ReadingSettings /><State /></>);
    expect(screen.getByTestId('settings')).toHaveTextContent('22:');
    fireEvent.click(screen.getByText('Reset to default'));
    expect(screen.getByTestId('settings')).toHaveTextContent('auto:');
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
    fireEvent.click(screen.getByLabelText('Decrease text size'));
    expect(screen.getByTestId('settings')).toHaveTextContent('15:');
  });
  it('closes an open menu with Escape after keyboard focus moves outside', () => {
    render(<><ReadingSettings /><button>Outside</button></>);
    const details = screen.getByLabelText('Chat options').closest('details')!;
    details.open = true;
    screen.getByText('Outside').focus();
    fireEvent.keyDown(screen.getByText('Outside'), { key: 'Escape' });
    expect(details.open).toBe(false);
    expect(screen.getByLabelText('Chat options')).toHaveFocus();
  });
  it('keeps working when writes fail and resets after another tab clears storage', () => {
    localStorage.setItem('conductor-reading-size', '15');
    render(<><ReadingSettings /><State /></>);
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
    fireEvent.click(screen.getByLabelText('Increase text size'));
    expect(screen.getByTestId('settings')).toHaveTextContent('16:');
    write.mockRestore();
    act(() => {
      localStorage.removeItem('conductor-reading-size');
      window.dispatchEvent(new StorageEvent('storage', { key: 'conductor-reading-size' }));
    });
    expect(screen.getByTestId('settings')).toHaveTextContent('auto:');
  });
  it('persists selectable columns and handles invalid stored preferences', () => {
    render(<><TaskColumnSettings /><State /></>);
    fireEvent.click(screen.getByLabelText('Backend'));
    fireEvent.click(screen.getByLabelText('Project'));
    expect(screen.getByTestId('settings')).toHaveTextContent('preview,project,host');
    expect(JSON.parse(localStorage.getItem('conductor-task-columns')!)).toContain('project');
    act(() => {
      localStorage.setItem('conductor-reading-size', '999');
      localStorage.setItem('conductor-task-columns', 'broken');
      window.dispatchEvent(new Event('storage'));
    });
    expect(screen.getByTestId('settings')).toHaveTextContent('auto:preview,backend,host');
  });
});
