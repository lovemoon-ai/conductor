import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ProjectDetailsDialog } from './ProjectDetailsDialog';
import {
  MAX_MEMO_CONTENT_CHARS,
  MAX_MEMOS_PER_PROJECT,
  readProjectMemos,
} from './ProjectDetailsDialog.utils';

const updateProjectMock = vi.fn();
const pushToastMock = vi.fn();
const confirmMock = vi.fn();

// Hoisted store state so the mocked `useProjectsStore` hook and the static
// `useProjectsStore.getState` / `setState` accessors share the same data —
// the dialog uses both surfaces (selector for `updateProject`, static for the
// optimistic snapshot/rollback path).
const storeState = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
}));

const resetStoreProjects = (projects: Array<Record<string, unknown>>) => {
  storeState.projects = projects.map((entry) => ({ ...entry }));
};

// Replace the native <dialog>-based Dialog with a plain wrapper so the tests
// can read content via Testing Library without relying on jsdom's incomplete
// HTMLDialogElement implementation.
vi.mock('@/components/common/Dialog', () => ({
  Dialog: ({ open, children, title }: { open: boolean; children: ReactNode; title: string }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    ) : null,
}));

vi.mock('@/components/common/FeedbackProvider', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock('../store', () => {
  const hook = (selector?: (state: { updateProject: typeof updateProjectMock }) => unknown) =>
    selector ? selector({ updateProject: updateProjectMock }) : { updateProject: updateProjectMock };
  // Mirror zustand's static accessors so the dialog can read/write the
  // shared `projects` list for optimistic updates.
  (hook as any).getState = () => storeState;
  (hook as any).setState = (
    next: Partial<typeof storeState> | ((state: typeof storeState) => Partial<typeof storeState>),
  ) => {
    const patch = typeof next === 'function' ? next(storeState) : next;
    Object.assign(storeState, patch);
  };
  return { useProjectsStore: hook };
});

const baseProject = {
  id: 'project-memo',
  name: 'Memo Project',
  daemonHost: 'daemon-a',
  workspacePath: '/repo/memo',
} as const;

describe('ProjectDetailsDialog', () => {
  beforeEach(() => {
    updateProjectMock.mockReset();
    pushToastMock.mockReset();
    confirmMock.mockReset();
    resetStoreProjects([]);
  });

  it('renders existing memos in reverse chronological order', () => {
    const project = {
      ...baseProject,
      metadata: {
        memos: [
          { id: 'm1', content: 'first memo', createdAt: '2026-05-01T08:00:00.000Z' },
          { id: 'm2', content: 'latest memo', createdAt: '2026-05-10T12:30:00.000Z' },
        ],
      },
    } as any;
    resetStoreProjects([project]);

    render(<ProjectDetailsDialog open project={project} onClose={vi.fn()} />);

    const memoItems = screen.getAllByRole('listitem');
    expect(memoItems).toHaveLength(2);
    expect(memoItems[0]).toHaveTextContent('latest memo');
    expect(memoItems[1]).toHaveTextContent('first memo');
  });

  it('shows empty state when project has no memos', () => {
    render(<ProjectDetailsDialog open project={baseProject as any} onClose={vi.fn()} />);
    expect(screen.getByText(/No memos yet/)).toBeInTheDocument();
  });

  it('renders a simplified overview with commit time and GitHub link', () => {
    const project = {
      ...baseProject,
      repoRoot: '/repo',
      worktreeBranch: 'main',
      lastCommit: 'abc123',
      lastCommitAt: '2026-05-12T14:30:00',
      gitRemoteUrl: 'github.com/foo/bar',
      createdAt: '2026-05-01T08:00:00.000Z',
    } as any;

    render(<ProjectDetailsDialog open project={project} onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: 'Memo Project' })).toBeInTheDocument();
    expect(screen.queryByText('Name')).toBeNull();
    expect(screen.queryByText('Repo root')).toBeNull();
    expect(screen.queryByText('Binding')).toBeNull();
    expect(screen.queryByText('abc123')).toBeNull();
    expect(screen.getByText('2026-05-12 14:30')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'github.com/foo/bar' })).toHaveAttribute(
      'href',
      'https://github.com/foo/bar',
    );
  });

  it('adds a new memo by prepending and patching metadata', async () => {
    const project = {
      ...baseProject,
      metadata: {
        bindingCandidate: { daemonHost: 'daemon-a', workspacePath: '/repo/memo' },
        memos: [
          { id: 'm1', content: 'first memo', createdAt: '2026-05-01T08:00:00.000Z' },
        ],
      },
    } as any;
    resetStoreProjects([project]);
    updateProjectMock.mockResolvedValueOnce(project);

    render(<ProjectDetailsDialog open project={project} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('New memo'), { target: { value: 'a fresh thought' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add memo' }));

    await waitFor(() => expect(updateProjectMock).toHaveBeenCalledTimes(1));
    const [projectId, payload] = updateProjectMock.mock.calls[0];
    expect(projectId).toBe('project-memo');
    expect(payload.metadata.bindingCandidate).toEqual({
      daemonHost: 'daemon-a',
      workspacePath: '/repo/memo',
    });
    expect(payload.metadata.memos).toHaveLength(2);
    expect(payload.metadata.memos[0].content).toBe('a fresh thought');
    expect(payload.metadata.memos[1].id).toBe('m1');
  });

  it('optimistically renders the new memo before the PATCH resolves and clears the draft on success', async () => {
    const project = { ...baseProject, metadata: { memos: [] } } as any;
    resetStoreProjects([project]);

    // Hold the PATCH open so we can observe the optimistic state.
    const deferred: { resolve: (value: unknown) => void } = { resolve: () => {} };
    updateProjectMock.mockImplementationOnce(
      () => new Promise<unknown>((resolve) => {
        deferred.resolve = resolve;
      }),
    );

    render(<ProjectDetailsDialog open project={project} onClose={vi.fn()} />);
    const textarea = screen.getByLabelText('New memo') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'instant' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add memo' }));

    // Memo lands in the store immediately, even though PATCH is still pending.
    await waitFor(() => {
      expect(readProjectMemos(storeState.projects[0] as any)).toHaveLength(1);
    });
    expect(readProjectMemos(storeState.projects[0] as any)[0].content).toBe('instant');
    // Draft is NOT cleared yet — we only clear it on PATCH success so a
    // late failure leaves the user's text intact (no flicker).
    expect(textarea.value).toBe('instant');

    deferred.resolve(project);
    await waitFor(() => expect(updateProjectMock).toHaveBeenCalledTimes(1));
    // After success the composition area is cleared.
    await waitFor(() => expect(textarea.value).toBe(''));
  });

  it('keeps the draft and rolls back the optimistic memo when the PATCH fails', async () => {
    const project = { ...baseProject, metadata: { memos: [] } } as any;
    resetStoreProjects([project]);
    updateProjectMock.mockRejectedValueOnce(new Error('network down'));

    render(<ProjectDetailsDialog open project={project} onClose={vi.fn()} />);
    const textarea = screen.getByLabelText('New memo') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'will fail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add memo' }));

    await waitFor(() =>
      expect(pushToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Failed to save memo', variant: 'error' }),
      ),
    );
    // The optimistic memo is removed from the shared store after rollback.
    expect(readProjectMemos(storeState.projects[0] as any)).toHaveLength(0);
    // Draft is preserved throughout — the user never sees their text "disappear".
    expect(textarea.value).toBe('will fail');
  });

  it('rollback restores only the failing project, preserving concurrent updates to other projects', async () => {
    // Two projects in the store. We will mutate B while a PATCH on A is in
    // flight, then fail the PATCH. The narrowed rollback must keep B's
    // mutation intact instead of overwriting the whole `projects` array.
    const projectA = { ...baseProject, metadata: { memos: [] } } as any;
    const projectB = {
      id: 'project-other',
      name: 'Other Project',
      daemonHost: 'daemon-b',
      workspacePath: '/repo/other',
      metadata: null,
      taskStatusCounts: { running: 0 },
    } as any;
    resetStoreProjects([projectA, projectB]);

    const deferred: { reject: (reason: unknown) => void } = { reject: () => {} };
    updateProjectMock.mockImplementationOnce(
      () => new Promise<unknown>((_, reject) => {
        deferred.reject = reject;
      }),
    );

    render(<ProjectDetailsDialog open project={projectA} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('New memo'), { target: { value: 'A memo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add memo' }));

    // Wait until the optimistic memo lands so we know the snapshot was captured.
    await waitFor(() => {
      expect(readProjectMemos(storeState.projects[0] as any)).toHaveLength(1);
    });

    // Simulate a concurrent agent push that updates B's task counts.
    storeState.projects = storeState.projects.map((p: any) =>
      p.id === 'project-other' ? { ...p, taskStatusCounts: { running: 7 } } : p,
    );

    deferred.reject(new Error('boom'));

    await waitFor(() =>
      expect(pushToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Failed to save memo' }),
      ),
    );

    const restoredA = storeState.projects.find((p: any) => p.id === projectA.id) as any;
    const concurrentB = storeState.projects.find((p: any) => p.id === 'project-other') as any;
    expect(readProjectMemos(restoredA)).toHaveLength(0);
    // The crucial assertion: B's concurrent update is *not* clobbered by the
    // rollback. With the previous "snapshot the whole array" pattern this
    // would fail and `running` would be 0.
    expect(concurrentB.taskStatusCounts.running).toBe(7);
  });

  it('submits the draft on Cmd/Ctrl + Enter', async () => {
    const project = { ...baseProject, metadata: { memos: [] } } as any;
    resetStoreProjects([project]);
    updateProjectMock.mockResolvedValueOnce(project);

    render(<ProjectDetailsDialog open project={project} onClose={vi.fn()} />);
    const textarea = screen.getByLabelText('New memo');
    fireEvent.change(textarea, { target: { value: 'shortcut memo' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(updateProjectMock).toHaveBeenCalledTimes(1));
    expect(updateProjectMock.mock.calls[0][1].metadata.memos[0].content).toBe('shortcut memo');
  });

  it('deletes a memo after confirmation', async () => {
    confirmMock.mockResolvedValueOnce(true);
    const project = {
      ...baseProject,
      metadata: {
        memos: [
          { id: 'm1', content: 'keep me', createdAt: '2026-05-01T08:00:00.000Z' },
          { id: 'm2', content: 'remove me', createdAt: '2026-05-10T12:30:00.000Z' },
        ],
      },
    } as any;
    resetStoreProjects([project]);
    updateProjectMock.mockResolvedValueOnce(project);

    render(<ProjectDetailsDialog open project={project} onClose={vi.fn()} />);
    // Newest memo ('remove me') renders first.
    fireEvent.click(screen.getAllByLabelText('Delete memo')[0]);

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await waitFor(() => expect(updateProjectMock).toHaveBeenCalledTimes(1));
    const [, payload] = updateProjectMock.mock.calls[0];
    expect(payload.metadata.memos).toHaveLength(1);
    expect(payload.metadata.memos[0].id).toBe('m1');
  });

  it('does not patch metadata when delete is cancelled', async () => {
    confirmMock.mockResolvedValueOnce(false);
    const project = {
      ...baseProject,
      metadata: {
        memos: [{ id: 'm1', content: 'keep me', createdAt: '2026-05-01T08:00:00.000Z' }],
      },
    } as any;
    resetStoreProjects([project]);

    render(<ProjectDetailsDialog open project={project} onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Delete memo'));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    // The cancel branch must not fan out to the API.
    expect(updateProjectMock).not.toHaveBeenCalled();
    // And the local store must still hold the original memo.
    expect(readProjectMemos(storeState.projects[0] as any)).toHaveLength(1);
  });

  it('does not render secondary daemon memos in a merged project details dialog', () => {
    const project = {
      ...baseProject,
      daemonHost: 'daemon-a',
      metadata: {
        memos: [
          { id: 'shared', content: 'project-level memo', createdAt: '2026-05-10T12:30:00.000Z' },
        ],
      },
    } as any;
    const mergedMembers = [
      project,
      {
        ...baseProject,
        id: 'project-memo-b',
        daemonHost: 'daemon-b',
        metadata: {
          memos: [
            { id: 'daemon-b-only', content: 'daemon-specific memo', createdAt: '2026-05-11T12:30:00.000Z' },
          ],
        },
      },
    ] as any;
    resetStoreProjects(mergedMembers);

    render(
      <ProjectDetailsDialog
        open
        project={project}
        mergedMembers={mergedMembers}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('project-level memo')).toBeInTheDocument();
    expect(screen.queryByText('daemon-specific memo')).toBeNull();
  });

  it('mirrors added memos to every member of a merged project group', async () => {
    const project = {
      ...baseProject,
      daemonHost: 'daemon-a',
      metadata: {
        memos: [
          { id: 'm1', content: 'existing shared memo', createdAt: '2026-05-01T08:00:00.000Z' },
        ],
      },
    } as any;
    const projectB = {
      ...baseProject,
      id: 'project-memo-b',
      daemonHost: 'daemon-b',
      metadata: { color: 'blue' },
    } as any;
    const mergedMembers = [project, projectB];
    resetStoreProjects(mergedMembers);
    updateProjectMock.mockResolvedValue(project);

    render(
      <ProjectDetailsDialog
        open
        project={project}
        mergedMembers={mergedMembers}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('New memo'), { target: { value: 'new shared memo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add memo' }));

    await waitFor(() => expect(updateProjectMock).toHaveBeenCalledTimes(2));
    expect(updateProjectMock.mock.calls.map(([projectId]) => projectId)).toEqual([
      'project-memo',
      'project-memo-b',
    ]);
    for (const [, payload] of updateProjectMock.mock.calls) {
      expect(payload.metadata.memos).toHaveLength(2);
      expect(payload.metadata.memos[0].content).toBe('new shared memo');
      expect(payload.metadata.memos[1].id).toBe('m1');
    }
    const secondaryPayload = updateProjectMock.mock.calls[1][1];
    expect(secondaryPayload.metadata.color).toBe('blue');
    expect(readProjectMemos(storeState.projects[0] as any)[0].content).toBe('new shared memo');
    expect(readProjectMemos(storeState.projects[1] as any)[0].content).toBe('new shared memo');
  });

  it('does not show daemon-scoped memo copy for merged groups', () => {
    const project = { ...baseProject, daemonHost: 'daemon-a' } as any;
    const mergedMembers = [
      project,
      { ...baseProject, id: 'project-memo-b', daemonHost: 'daemon-b' },
    ] as any;

    render(
      <ProjectDetailsDialog
        open
        project={project}
        mergedMembers={mergedMembers}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText(/merged across/)).toBeNull();
    expect(screen.queryByText(/stored on/)).toBeNull();
  });

  it('disables the submit button when the draft exceeds the per-memo length cap', () => {
    render(<ProjectDetailsDialog open project={baseProject as any} onClose={vi.fn()} />);
    const textarea = screen.getByLabelText('New memo');
    fireEvent.change(textarea, { target: { value: 'a'.repeat(MAX_MEMO_CONTENT_CHARS + 1) } });

    const submit = screen.getByRole('button', { name: 'Add memo' });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/memo too long/)).toBeInTheDocument();
  });

  it('disables submission once the project hits the memo count cap', () => {
    const memos = Array.from({ length: MAX_MEMOS_PER_PROJECT }, (_, index) => ({
      id: `m-${index}`,
      content: `memo ${index}`,
      createdAt: new Date(2026, 0, 1, 0, index).toISOString(),
    }));
    const project = { ...baseProject, metadata: { memos } } as any;
    resetStoreProjects([project]);

    render(<ProjectDetailsDialog open project={project} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('New memo'), { target: { value: 'one more' } });

    expect(screen.getByRole('button', { name: 'Add memo' })).toBeDisabled();
    expect(screen.getByText(/limit reached/)).toBeInTheDocument();
  });

  describe('readProjectMemos', () => {
    it('returns an empty array when metadata has no memos field', () => {
      expect(readProjectMemos({ ...baseProject, metadata: null } as any)).toEqual([]);
      expect(readProjectMemos({ ...baseProject, metadata: {} } as any)).toEqual([]);
    });

    it('filters out malformed memo entries', () => {
      const memos = readProjectMemos({
        ...baseProject,
        metadata: {
          memos: [
            { id: 'good', content: 'ok', createdAt: '2026-05-01T08:00:00.000Z' },
            { id: 42, content: 'bad', createdAt: '2026-05-02T08:00:00.000Z' }, // wrong type
            null,
            'not-an-object',
          ],
        },
      } as any);
      expect(memos).toEqual([
        { id: 'good', content: 'ok', createdAt: '2026-05-01T08:00:00.000Z' },
      ]);
    });
  });
});
