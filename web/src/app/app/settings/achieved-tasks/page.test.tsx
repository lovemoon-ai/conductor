import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AchievedTasksPage from './page';

const push = vi.fn();
const setLastPath = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@/components/layout/Header', () => ({
  Header: ({
    title,
    showBack,
    onBack,
  }: {
    title: string;
    showBack?: boolean;
    onBack?: () => void;
  }) => (
    <header>
      <h1>{title}</h1>
      {showBack ? <button onClick={onBack}>Back</button> : null}
    </header>
  ),
}));

vi.mock('@/features/achieved-tasks', () => ({
  ACHIEVED_TASKS_PATH: '/app/settings/achieved-tasks',
  AchievedTaskManager: () => <div>archived-task-manager</div>,
}));

vi.mock('@/features/settings', () => ({
  SETTINGS_ROOT_PATH: '/app/settings',
  useSettingsNavStore: (
    selector: (state: { setLastPath: typeof setLastPath }) => unknown,
  ) => selector({ setLastPath }),
}));

describe('AchievedTasksPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the manager, remembers the subpage, and returns to Settings', async () => {
    render(<AchievedTasksPage />);

    expect(screen.getByRole('heading', { name: 'Achieved tasks' })).toBeInTheDocument();
    expect(screen.getByText('archived-task-manager')).toBeInTheDocument();
    await waitFor(() => {
      expect(setLastPath).toHaveBeenCalledWith('/app/settings/achieved-tasks');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(push).toHaveBeenCalledWith('/app/settings');
  });
});
