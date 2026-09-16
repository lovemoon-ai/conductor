import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Project } from '@/shared/types';
import { ProjectTaskLabelsSection } from './ProjectTaskLabelsSection';

// Hoisted so the `vi.mock` factory (which is lifted above these declarations)
// can close over the same mock instance the tests assert on.
const { updateProjectGroupMetadataMock, storeState } = vi.hoisted(() => ({
  updateProjectGroupMetadataMock: vi.fn(),
  // Everything in the projects store, including hidden members the project
  // list leaves out of the `members` prop.
  storeState: { projects: [] as any[] },
}));
const pushToastMock = vi.fn();
const confirmMock = vi.fn();

vi.mock('@/components/common/FeedbackProvider', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock('../store', () => {
  const buildState = () => ({
    updateProjectGroupMetadata: updateProjectGroupMetadataMock,
    projects: storeState.projects,
  });
  const hook = (selector?: (s: ReturnType<typeof buildState>) => unknown) =>
    selector ? selector(buildState()) : buildState();
  return { useProjectsStore: hook };
});

const project = (
  id: string,
  daemonHost: string,
  labels: Array<{ id: string; name: string }> = [],
): Project => ({
  id,
  name: 'conductor',
  daemonHost,
  metadata: labels.length > 0 ? { taskLabels: labels } : null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

/**
 * The label list the most recent fan-out would write. The store action now
 * receives a builder rather than a finished payload, so run it against a bare
 * project and read the metadata key back out.
 */
const lastWrittenLabels = () => {
  const build = updateProjectGroupMetadataMock.mock.calls.at(-1)?.[1];
  if (!build) return undefined;
  return build({ id: 'p1', name: 'conductor', metadata: null })?.taskLabels;
};

const lastWrittenIds = () => updateProjectGroupMetadataMock.mock.calls.at(-1)?.[0];

describe('ProjectTaskLabelsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.projects = [];
    updateProjectGroupMetadataMock.mockResolvedValue(undefined);
    confirmMock.mockResolvedValue(true);
  });

  it('renders the empty state when the project defines no labels', () => {
    render(<ProjectTaskLabelsSection members={[project('p1', 'mac-mini')]} />);
    expect(screen.getByText(/No labels yet/i)).toBeTruthy();
  });

  it('adds a label and writes it to the project', async () => {
    render(<ProjectTaskLabelsSection members={[project('p1', 'mac-mini')]} />);

    fireEvent.change(screen.getByLabelText('New label name'), {
      target: { value: 'needs review' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(updateProjectGroupMetadataMock).toHaveBeenCalled());
    expect(lastWrittenIds()).toEqual(['p1']);
    expect(lastWrittenLabels()).toEqual([
      expect.objectContaining({ name: 'needs review' }),
    ]);
  });

  it('fans the write out to every member of a merged cross-daemon group', async () => {
    // The headline requirement: configuring labels on one daemon's project must
    // reach the merged siblings.
    render(
      <ProjectTaskLabelsSection
        members={[project('p1', 'mac-mini'), project('p2', 'linux-box')]}
      />,
    );

    fireEvent.change(screen.getByLabelText('New label name'), {
      target: { value: 'infra' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(updateProjectGroupMetadataMock).toHaveBeenCalled());
    expect(lastWrittenIds()).toEqual(['p1', 'p2']);
  });

  it('shows the union of labels across merged members', () => {
    render(
      <ProjectTaskLabelsSection
        members={[
          project('p1', 'mac-mini', [{ id: 'l1', name: 'bug' }]),
          project('p2', 'linux-box', [{ id: 'l2', name: 'infra' }]),
        ]}
      />,
    );
    expect(screen.getByText('bug')).toBeTruthy();
    expect(screen.getByText('infra')).toBeTruthy();
  });

  it('shows labels held only by a HIDDEN merged member, matching what task cards show', () => {
    // Regression: settings read only the visible members it was handed while
    // task cards and the API union every member. A label deleted here survived
    // on the hidden member and reappeared on cards.
    const visible = { ...project('p1', 'mac-mini'), gitRemoteUrl: 'github.com/acme/c' };
    const hidden = {
      ...project('p2', 'linux-box', [{ id: 'l9', name: 'legacy' }]),
      gitRemoteUrl: 'github.com/acme/c',
      hidden: true,
    };
    storeState.projects = [visible, hidden];

    render(<ProjectTaskLabelsSection members={[visible]} />);

    expect(screen.getByText('legacy')).toBeTruthy();
  });

  it('deleting removes the label from the hidden member too', async () => {
    const visible = { ...project('p1', 'mac-mini', [{ id: 'l9', name: 'legacy' }]), gitRemoteUrl: 'github.com/acme/c' };
    const hidden = {
      ...project('p2', 'linux-box', [{ id: 'l9', name: 'legacy' }]),
      gitRemoteUrl: 'github.com/acme/c',
      hidden: true,
    };
    storeState.projects = [visible, hidden];

    render(<ProjectTaskLabelsSection members={[visible]} />);
    fireEvent.click(screen.getByLabelText('Delete label legacy'));

    await waitFor(() => expect(updateProjectGroupMetadataMock).toHaveBeenCalled());
    // The store expands these ids to the full group; the payload itself is the
    // emptied list, so every member it reaches ends up without the label.
    expect(lastWrittenLabels()).toEqual([]);
  });

  it('keeps two same-named labels from different daemons distinct', () => {
    render(
      <ProjectTaskLabelsSection
        members={[
          project('p1', 'mac-mini', [{ id: 'l1', name: 'bug' }]),
          project('p2', 'linux-box', [{ id: 'l2', name: 'bug' }]),
        ]}
      />,
    );
    // Both shown, so the user can see and delete the duplicate.
    expect(screen.getAllByText('bug')).toHaveLength(2);
  });

  it('tells the user the labels are shared when the project is merged', () => {
    render(
      <ProjectTaskLabelsSection
        members={[project('p1', 'mac-mini'), project('p2', 'linux-box')]}
      />,
    );
    expect(screen.getByText(/Shared across all 2 daemons/i)).toBeTruthy();
  });

  it('refuses a duplicate name instead of writing it', async () => {
    render(
      <ProjectTaskLabelsSection
        members={[project('p1', 'mac-mini', [{ id: 'l1', name: 'bug' }])]}
      />,
    );

    fireEvent.change(screen.getByLabelText('New label name'), {
      target: { value: '  BUG  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(pushToastMock).toHaveBeenCalled());
    expect(pushToastMock.mock.calls[0][0].title).toMatch(/already exists/i);
    expect(updateProjectGroupMetadataMock).not.toHaveBeenCalled();
  });

  it('ignores a blank name', () => {
    render(<ProjectTaskLabelsSection members={[project('p1', 'mac-mini')]} />);
    fireEvent.change(screen.getByLabelText('New label name'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(updateProjectGroupMetadataMock).not.toHaveBeenCalled();
  });

  it('renames a label in place', async () => {
    render(
      <ProjectTaskLabelsSection
        members={[project('p1', 'mac-mini', [{ id: 'l1', name: 'bug' }])]}
      />,
    );

    fireEvent.click(screen.getByTitle('Click to rename'));
    const input = screen.getByLabelText('Rename label bug');
    fireEvent.change(input, { target: { value: 'defect' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(updateProjectGroupMetadataMock).toHaveBeenCalled());
    expect(lastWrittenLabels()).toEqual([{ id: 'l1', name: 'defect' }]);
  });

  it('deletes a label after confirmation', async () => {
    render(
      <ProjectTaskLabelsSection
        members={[
          project('p1', 'mac-mini', [
            { id: 'l1', name: 'bug' },
            { id: 'l2', name: 'chore' },
          ]),
        ]}
      />,
    );

    fireEvent.click(screen.getByLabelText('Delete label bug'));

    await waitFor(() => expect(updateProjectGroupMetadataMock).toHaveBeenCalled());
    expect(lastWrittenLabels()).toEqual([{ id: 'l2', name: 'chore' }]);
  });

  it('does not delete when the confirmation is declined', async () => {
    confirmMock.mockResolvedValue(false);
    render(
      <ProjectTaskLabelsSection
        members={[project('p1', 'mac-mini', [{ id: 'l1', name: 'bug' }])]}
      />,
    );

    fireEvent.click(screen.getByLabelText('Delete label bug'));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(updateProjectGroupMetadataMock).not.toHaveBeenCalled();
  });

  it('surfaces a failed write as a toast and drops the optimistic row', async () => {
    updateProjectGroupMetadataMock.mockRejectedValue(new Error('daemon offline'));
    render(<ProjectTaskLabelsSection members={[project('p1', 'mac-mini')]} />);

    fireEvent.change(screen.getByLabelText('New label name'), {
      target: { value: 'infra' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(pushToastMock).toHaveBeenCalled());
    expect(pushToastMock.mock.calls[0][0].description).toContain('daemon offline');
    // Falls back to the store's view, which never received the label.
    await waitFor(() => expect(screen.getByText(/No labels yet/i)).toBeTruthy());
  });
});
