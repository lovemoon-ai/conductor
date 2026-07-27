import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { FeedbackProvider, useConfirm } from './FeedbackProvider';

function ConfirmHarness() {
  const { confirm } = useConfirm();
  const [results, setResults] = useState<string[]>([]);

  const open = async (name: string) => {
    const accepted = await confirm({
      title: `${name} confirmation`,
      confirmLabel: `Confirm ${name}`,
    });
    setResults((current) => [...current, `${name}:${accepted}`]);
  };

  return (
    <>
      <button type="button" onClick={() => void open('first')}>First action</button>
      <button type="button" onClick={() => void open('second')}>Second action</button>
      <output>{results.join(',')}</output>
    </>
  );
}

describe('FeedbackProvider', () => {
  it('cancels an older pending confirm before opening a newer one', async () => {
    render(
      <FeedbackProvider>
        <ConfirmHarness />
      </FeedbackProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'First action' }));
    expect(screen.getByText('first confirmation')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Second action' }));
    expect(screen.getByText('second confirmation')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('first:false')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Confirm second' }));
    await waitFor(() => {
      expect(screen.getByText('first:false,second:true')).toBeInTheDocument();
    });
  });
});
