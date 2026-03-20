import { useEffect } from 'react';
import { JWT_STORAGE_KEY } from '@/lib/auth/token-storage';
import { AUTH_SESSION_STORAGE_KEY } from '../stores/auth';

function isAuthStorageKey(key: string | null): boolean {
  return key === null || key === JWT_STORAGE_KEY || key === AUTH_SESSION_STORAGE_KEY;
}

export function useAuthStorageSync(syncAuth: () => Promise<void>): void {
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (!isAuthStorageKey(event.key)) {
        return;
      }

      void syncAuth();
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [syncAuth]);
}
