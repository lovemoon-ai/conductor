import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QuotaBar } from './QuotaBar';

describe('QuotaBar', () => {
  it('renders date-only reset values without inventing a time', () => {
    const expectedDate = new Intl.DateTimeFormat(undefined, {
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(2026, 4, 17));

    render(
      <QuotaBar
        label="Chat"
        window={{
          usedPercent: 6,
          remainingPercent: 94,
          resetOnDate: '2026-05-17',
          status: 'allowed',
        }}
      />,
    );

    expect(
      screen.getByText((content) => content.includes(`reset ${expectedDate}`)),
    ).toBeInTheDocument();
    expect(screen.getByText((content) => !content.includes(':') && content.includes('reset'))).toBeInTheDocument();
  });
});
