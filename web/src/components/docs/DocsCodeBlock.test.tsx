import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DocsCodeBlock } from './DocsCodeBlock';

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

const copyToClipboardMock = vi.fn();
vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: (value: string) => copyToClipboardMock(value),
}));

describe('DocsCodeBlock', () => {
  beforeEach(() => {
    copyToClipboardMock.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('copies the code text and flips the button label back after 1.5s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<DocsCodeBlock><code>pnpm install</code></DocsCodeBlock>);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalledWith('pnpm install'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    vi.advanceTimersByTime(1500);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument());
  });

  it('keeps the idle label when the copy fails', async () => {
    copyToClipboardMock.mockResolvedValue(false);
    render(<DocsCodeBlock><code>pnpm install</code></DocsCodeBlock>);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull();
  });

  it('does not attempt to copy an empty block', () => {
    render(<DocsCodeBlock>{''}</DocsCodeBlock>);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(copyToClipboardMock).not.toHaveBeenCalled();
  });
});
