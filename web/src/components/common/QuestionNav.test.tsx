import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QuestionNav } from './QuestionNav';

describe('QuestionNav', () => {
  // jsdom does not implement scrollIntoView, so we stub it on every element.
  let scrollIntoViewMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollIntoViewMock = vi.fn();
    // The mock lives on the prototype so every <button> picks it up — the
    // component grabs the active dot by ref and we want to record every call.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoViewMock,
    });
  });

  afterEach(() => {
    // Drop the mock so it doesn't bleed into sibling suites in the same file.
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it('scrolls the active dot into view using `block: nearest` when it changes', () => {
    const { rerender, container } = render(
      <QuestionNav count={5} activeIndex={0} onJump={() => {}} />,
    );

    // Initial render: scrollIntoView fires for index 0.
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(5);
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith({
      block: 'nearest',
      inline: 'nearest',
    });

    scrollIntoViewMock.mockClear();
    rerender(<QuestionNav count={5} activeIndex={3} onJump={() => {}} />);

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    });
    // The call must come from the dot at index 3, not some other one — the
    // contract is "the *active* dot is the one nudged into view".
    expect(scrollIntoViewMock.mock.instances[0]).toBe(buttons[3]);
  });

  it('does not scroll the rail while the nav is hidden', () => {
    const { rerender } = render(
      <QuestionNav count={5} activeIndex={0} onJump={() => {}} visible={false} />,
    );

    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    // While hidden, even an active-index change should stay silent — the
    // rail is opacity-0 / pointer-events-none and scrolling it would risk
    // perturbing ancestor scroll containers for no user-visible benefit.
    rerender(
      <QuestionNav count={5} activeIndex={2} onJump={() => {}} visible={false} />,
    );
    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    // Becoming visible should re-sync the rail to the current active dot
    // so the user sees the right position the moment the nav appears.
    rerender(
      <QuestionNav count={5} activeIndex={2} onJump={() => {}} visible={true} />,
    );
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when count is 0 and does not attempt to scroll', () => {
    const { container } = render(
      <QuestionNav count={0} activeIndex={0} onJump={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });
});
