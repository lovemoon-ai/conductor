import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';

let viewport: EventTarget & { height: number; offsetTop: number; scale: number };

beforeEach(() => {
  viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 844);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Dialog visual viewport', () => {
  it('follows keyboard resize and panning, then recovers when the keyboard closes', () => {
    render(<Dialog open onClose={() => {}} title="Task" mobileSheet footer={<button>Create</button>}>
      <textarea aria-label="Draft" defaultValue="Keep this draft" />
    </Dialog>);
    const dialog = screen.getByRole('dialog');
    act(() => {
      viewport.height = 360;
      viewport.dispatchEvent(new Event('resize'));
    });
    expect(dialog.style.getPropertyValue('--dialog-viewport-height')).toBe('360px');
    act(() => {
      viewport.offsetTop = 48;
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(dialog.style.getPropertyValue('--dialog-viewport-top')).toBe('48px');
    expect(screen.getByRole('textbox')).toHaveValue('Keep this draft');
    act(() => {
      viewport.height = 844;
      viewport.offsetTop = 0;
      viewport.dispatchEvent(new Event('resize'));
    });
    expect(dialog.style.getPropertyValue('--dialog-viewport-height')).toBe('844px');
    expect(dialog.style.getPropertyValue('--dialog-viewport-top')).toBe('0px');
  });

  it('ignores pinch zoom and releases viewport listeners on unmount', () => {
    const remove = vi.spyOn(viewport, 'removeEventListener');
    const view = render(<Dialog open onClose={() => {}} title="Task">Body</Dialog>);
    act(() => {
      viewport.scale = 2;
      viewport.height = 200;
      viewport.offsetTop = 70;
      viewport.dispatchEvent(new Event('resize'));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.style.getPropertyValue('--dialog-viewport-height')).toBe('844px');
    expect(dialog.style.getPropertyValue('--dialog-viewport-top')).toBe('0px');
    view.unmount();
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
