import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CatchphraseSettingsCard } from './CatchphraseSettingsCard';
import { useCatchphrasesStore, type Catchphrase } from '../store';

const sample = (overrides: Partial<Catchphrase> = {}): Catchphrase => ({
  id: overrides.id ?? 'cp-1',
  text: overrides.text ?? 'phrase',
  sortOrder: overrides.sortOrder ?? 0,
  lastUsedAt: overrides.lastUsedAt ?? null,
  createdAt: overrides.createdAt ?? '2026-06-06T00:00:00Z',
  updatedAt: overrides.updatedAt ?? '2026-06-06T00:00:00Z',
});

describe('CatchphraseSettingsCard', () => {
  beforeEach(() => {
    vi.useRealTimers();
    useCatchphrasesStore.setState({
      catchphrases: [],
      hydrated: true,
      loading: false,
      error: null,
    });
  });

  it('renders the empty-state hint when there are no rows', () => {
    render(<CatchphraseSettingsCard />);
    expect(screen.getByText(/还没有口头禅/i)).toBeInTheDocument();
  });

  it('renders each catchphrase row', () => {
    useCatchphrasesStore.setState({
      catchphrases: [
        sample({ id: 'cp-a', text: 'phrase A' }),
        sample({ id: 'cp-b', text: 'phrase B', sortOrder: 1 }),
      ],
    });
    render(<CatchphraseSettingsCard />);
    expect(screen.getByText('phrase A')).toBeInTheDocument();
    expect(screen.getByText('phrase B')).toBeInTheDocument();
  });

  it('creates a new catchphrase via the inline composer', async () => {
    const createSpy = vi.fn(async (text: string) => sample({ id: 'cp-new', text }));
    useCatchphrasesStore.setState({ create: createSpy as any });
    render(<CatchphraseSettingsCard />);
    fireEvent.click(screen.getByTestId('catchphrase-new'));
    fireEvent.change(screen.getByTestId('catchphrase-new-textarea'), {
      target: { value: 'hello world' },
    });
    fireEvent.click(screen.getByTestId('catchphrase-save-new'));
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith('hello world');
    });
  });

  it('closes the editor when the row being edited is removed by a realtime push', () => {
    useCatchphrasesStore.setState({
      catchphrases: [sample({ id: 'cp-edit', text: 'will vanish' })],
    });
    render(<CatchphraseSettingsCard />);
    fireEvent.click(screen.getByTestId('catchphrase-edit-cp-edit'));
    expect(screen.getByTestId('catchphrase-edit-textarea-cp-edit')).toBeInTheDocument();

    // Simulate a realtime push deleting cp-edit from another tab.
    act(() => {
      useCatchphrasesStore.getState().applyCatchphrases([]);
    });

    expect(screen.queryByTestId('catchphrase-edit-textarea-cp-edit')).not.toBeInTheDocument();
  });

  it('keeps the editor open and preserves the draft when save fails', async () => {
    const updateSpy = vi.fn(async () => false);
    useCatchphrasesStore.setState({
      catchphrases: [sample({ id: 'cp-edit', text: 'old text' })],
      update: updateSpy as any,
    });
    render(<CatchphraseSettingsCard />);
    fireEvent.click(screen.getByTestId('catchphrase-edit-cp-edit'));
    const textarea = screen.getByTestId('catchphrase-edit-textarea-cp-edit') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'new unsaved text' } });
    fireEvent.click(screen.getByTestId('catchphrase-save-edit-cp-edit'));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith('cp-edit', 'new unsaved text');
    });
    expect(screen.getByTestId('catchphrase-edit-textarea-cp-edit')).toBeInTheDocument();
    expect((screen.getByTestId('catchphrase-edit-textarea-cp-edit') as HTMLTextAreaElement).value).toBe(
      'new unsaved text',
    );
  });

  it('two-step delete confirm auto-clears after 3 seconds', async () => {
    vi.useFakeTimers();
    const removeSpy = vi.fn(async () => undefined);
    useCatchphrasesStore.setState({
      catchphrases: [sample({ id: 'cp-del' })],
      remove: removeSpy as any,
    });
    render(<CatchphraseSettingsCard />);
    fireEvent.click(screen.getByTestId('catchphrase-delete-cp-del'));
    // Confirm state is communicated via aria-label/title rather than visible text
    // now that the delete button uses an icon.
    expect(screen.getByTestId('catchphrase-delete-cp-del')).toHaveAttribute(
      'aria-label',
      '再次点击确认删除',
    );

    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(screen.getByTestId('catchphrase-delete-cp-del')).toHaveAttribute(
      'aria-label',
      '删除',
    );
    expect(removeSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('a second click within the timeout actually deletes', async () => {
    const removeSpy = vi.fn(async () => undefined);
    useCatchphrasesStore.setState({
      catchphrases: [sample({ id: 'cp-del' })],
      remove: removeSpy as any,
    });
    render(<CatchphraseSettingsCard />);
    fireEvent.click(screen.getByTestId('catchphrase-delete-cp-del'));
    fireEvent.click(screen.getByTestId('catchphrase-delete-cp-del'));
    await waitFor(() => {
      expect(removeSpy).toHaveBeenCalledWith('cp-del');
    });
  });

  it('client enforces the 500-char max via textarea maxLength', () => {
    render(<CatchphraseSettingsCard />);
    fireEvent.click(screen.getByTestId('catchphrase-new'));
    const textarea = screen.getByTestId('catchphrase-new-textarea') as HTMLTextAreaElement;
    // The DOM-level maxLength attribute is the hard guardrail; the
    // onChange handler additionally slice()s the value to be defensive
    // against paste flows that bypass keyboard input.
    expect(textarea.maxLength).toBe(500);
  });

  it('client disables the new-catchphrase button when the user has hit the 100-row cap', () => {
    const cap = 100;
    useCatchphrasesStore.setState({
      catchphrases: Array.from({ length: cap }, (_, index) =>
        sample({ id: `cp-${index}`, sortOrder: index }),
      ),
    });
    render(<CatchphraseSettingsCard />);
    expect(screen.getByTestId('catchphrase-new')).toBeDisabled();
  });

  it('move-up sends the full id list to reorder', async () => {
    const reorderSpy = vi.fn(async () => undefined);
    useCatchphrasesStore.setState({
      catchphrases: [
        sample({ id: 'a', sortOrder: 0 }),
        sample({ id: 'b', sortOrder: 1 }),
        sample({ id: 'c', sortOrder: 2 }),
      ],
      reorder: reorderSpy as any,
    });
    render(<CatchphraseSettingsCard />);
    // Find the up arrow on row 'c' (index 2). There are multiple "Move up"
    // buttons; the third is for 'c'.
    const moveUpButtons = screen.getAllByLabelText('Move up');
    fireEvent.click(moveUpButtons[2]);
    await waitFor(() => {
      // Exact-match reorder per Round-1 fix: client always sends every id.
      expect(reorderSpy).toHaveBeenCalledWith(['a', 'c', 'b']);
    });
  });
});
