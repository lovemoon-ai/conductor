import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JWT_STORAGE_KEY } from '@/lib/auth/token-storage';
import { AUTH_SESSION_STORAGE_KEY } from '../store';
import { useAuthStorageSync } from './useAuthStorageSync';

function TestComponent({ onSync }: { onSync: () => Promise<void> }) {
  useAuthStorageSync(onSync);
  return null;
}

describe('useAuthStorageSync', () => {
  it('syncs auth when the JWT changes in another tab', () => {
    const onSync = vi.fn().mockResolvedValue(undefined);

    render(<TestComponent onSync={onSync} />);

    window.dispatchEvent(new StorageEvent('storage', { key: JWT_STORAGE_KEY }));

    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it('syncs auth when the persisted auth session changes in another tab', () => {
    const onSync = vi.fn().mockResolvedValue(undefined);

    render(<TestComponent onSync={onSync} />);

    window.dispatchEvent(new StorageEvent('storage', { key: AUTH_SESSION_STORAGE_KEY }));

    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated storage changes', () => {
    const onSync = vi.fn().mockResolvedValue(undefined);

    render(<TestComponent onSync={onSync} />);

    window.dispatchEvent(new StorageEvent('storage', { key: 'conductor.lang' }));

    expect(onSync).not.toHaveBeenCalled();
  });
});
