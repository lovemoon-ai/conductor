import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebAppLayout from './layout';
import { Dialog } from '@/components/common/Dialog';

const mocks = vi.hoisted(() => ({
  push: vi.fn(), replace: vi.fn(), initFromStorage: vi.fn().mockResolvedValue(undefined),
  fetchProjects: vi.fn(), fetchAgents: vi.fn(), startPolling: vi.fn(), stopPolling: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  usePathname: () => '/app/tasks',
}));
vi.mock('@/features/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({
    session: { user: { id: 'test-user' } }, initFromStorage: mocks.initFromStorage,
  }),
  useAuthStorageSync: vi.fn(),
}));
vi.mock('@/features/realtime', () => ({ useWebSocket: vi.fn() }));
vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: unknown) => unknown) => selector(mocks),
}));
vi.mock('@/features/agents', () => ({
  useAgentsStore: (selector: (state: unknown) => unknown) => selector(mocks),
}));
vi.mock('@/components/layout/Sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/components/layout/MobileNav', () => ({ MobileNav: () => null }));
vi.mock('@/components/layout/ProjectDocumentTitle', () => ({ ProjectDocumentTitle: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(cleanup);

describe('Workspace search shortcut', () => {
  it.each(['metaKey', 'ctrlKey'] as const)('preserves an open dialog draft with %s and resumes search after closing it', async (modifier) => {
    const content = (open: boolean) => <WebAppLayout>
      <Dialog open={open} onClose={() => {}} title="New task">
        <textarea aria-label="Task draft" defaultValue="Do not discard this work" />
      </Dialog>
    </WebAppLayout>;
    const view = render(content(true));
    await screen.findByRole('textbox', { name: 'Task draft' });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'k', [modifier]: true });
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('Do not discard this work');
    await act(async () => { view.rerender(content(false)); });
    fireEvent.keyDown(window, { key: 'k', [modifier]: true });
    expect(mocks.push).toHaveBeenCalledWith('/app/search');
  });

  it('respects a shortcut already consumed by a child control', async () => {
    render(<WebAppLayout><input aria-label="Editor" onKeyDown={(event) => event.preventDefault()} /></WebAppLayout>);
    await screen.findByRole('textbox');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'k', ctrlKey: true });
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
