import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthSession, AuthUser } from '../types';
import { createApiClientWithToken, getApiClient, type ApiClient, resetApiClient } from '../api/client';
import { clearStoredJwtToken, getStoredJwtToken, storeJwtToken } from '@/lib/auth/token-storage';

export const AUTH_SESSION_STORAGE_KEY = 'conductor-auth';
export const AUTH_USER_TOKEN_STORAGE_KEY = 'conductor.userToken';

interface AuthState {
  session: AuthSession | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  establishSession: (jwtToken: string, user?: AuthUser | null) => Promise<void>;
  setSession: (session: AuthSession | null) => void;
  login: (identifier: string, code: string) => Promise<void>;
  register: (identifier: string, code: string, inviteCode?: string) => Promise<void>;
  requestCode: (identifier: string) => Promise<void>;
  logout: () => void;
  fetchUser: () => Promise<void>;
  initFromStorage: () => Promise<void>;
  clearError: () => void;
}

function normalizeAuthUser(value: unknown): AuthUser | null {
  const payload =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const candidate =
    payload && Object.prototype.hasOwnProperty.call(payload, 'user')
      ? payload.user
      : value;

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }

  const user = candidate as Record<string, unknown>;
  if (typeof user.id !== 'string' || !user.id.trim()) {
    return null;
  }

  return {
    id: user.id,
    email: typeof user.email === 'string' ? user.email : null,
    phone: typeof user.phone === 'string' ? user.phone : null,
    name: typeof user.name === 'string' ? user.name : null,
  };
}

async function fetchUserToken(api: Pick<ApiClient, 'get' | 'post'>): Promise<string | null> {
  try {
    // Try to get existing token
    const { token } = await api.get<{ token: string | null }>('/auth/tokens/latest');
    if (token) return token;

    // Create new token if none exists
    const { token: newToken } = await api.post<{ token: string }>('/auth/tokens', {
      name: 'webapp',
    });
    return newToken;
  } catch {
    return null;
  }
}

async function fetchAuthenticatedUser(api: Pick<ApiClient, 'get'>): Promise<AuthUser | null> {
  const response = await api.get<unknown>('/auth/me');
  return normalizeAuthUser(response);
}

async function buildSession(
  jwtToken: string,
  existingSession: AuthSession | null,
  user?: AuthUser | null
): Promise<AuthSession> {
  const api = createApiClientWithToken(jwtToken);

  const authenticatedUser = user ?? await fetchAuthenticatedUser(api);
  if (!authenticatedUser) {
    throw new Error('Unauthorized');
  }

  const userToken =
    existingSession?.jwtToken === jwtToken && existingSession.userToken
      ? existingSession.userToken
      : await fetchUserToken(api);

  if (!userToken) {
    throw new Error('Failed to get user token');
  }

  return {
    jwtToken,
    userToken,
    user: authenticatedUser,
  };
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      session: null,
      isLoading: false,
      error: null,

      establishSession: async (jwtToken, user) => {
        set({ isLoading: true, error: null });
        try {
          const session = await buildSession(jwtToken, get().session, user);
          get().setSession(session);
          set({ isLoading: false });
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Failed to establish session',
          });
          throw error;
        }
      },

      setSession: (session) => {
        set({ session });
        if (session) {
          storeJwtToken(session.jwtToken);
          localStorage.setItem(AUTH_USER_TOKEN_STORAGE_KEY, session.userToken);
        } else {
          clearStoredJwtToken();
          localStorage.removeItem(AUTH_USER_TOKEN_STORAGE_KEY);
        }
      },

      initFromStorage: async () => {
        const jwt = getStoredJwtToken();
        if (!jwt) {
          if (typeof window !== 'undefined') {
            localStorage.removeItem(AUTH_USER_TOKEN_STORAGE_KEY);
            localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
          }
          if (get().session) {
            get().logout();
          }
          return;
        }

        set({ isLoading: true });
        try {
          const session = await buildSession(jwt, get().session);
          get().setSession(session);
        } catch {
          get().logout();
        } finally {
          set({ isLoading: false });
        }
      },

      requestCode: async (identifier) => {
        set({ isLoading: true, error: null });
        try {
          const api = getApiClient();
          await api.post('/auth/request-code', { identifier });
          set({ isLoading: false });
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Failed to request code',
          });
          throw error;
        }
      },

      login: async (identifier, code) => {
        set({ isLoading: true, error: null });
        try {
          const api = getApiClient();
          const response = await api.post<{
            token: string;
            user: AuthUser;
          }>('/auth/login', { identifier, code });

          await get().establishSession(response.token, response.user);
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Login failed',
          });
          throw error;
        }
      },

      register: async (identifier, code, inviteCode) => {
        set({ isLoading: true, error: null });
        try {
          const api = getApiClient();
          const response = await api.post<{
            token: string;
            user: AuthUser;
          }>('/auth/register', { identifier, code, inviteCode });

          await get().establishSession(response.token, response.user);
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Registration failed',
          });
          throw error;
        }
      },

      logout: () => {
        set({ session: null, isLoading: false, error: null });
        clearStoredJwtToken();
        if (typeof window !== 'undefined') {
          localStorage.removeItem(AUTH_USER_TOKEN_STORAGE_KEY);
          localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
        }
        resetApiClient();
      },

      fetchUser: async () => {
        const { session } = get();
        if (!session) return;

        try {
          const user = await fetchAuthenticatedUser(createApiClientWithToken(session.jwtToken));
          if (!user) {
            throw new Error('Unauthorized');
          }
          set({
            session: { ...session, user },
          });
        } catch {
          // Token might be invalid, logout
          get().logout();
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: AUTH_SESSION_STORAGE_KEY,
      partialize: (state) => ({ session: state.session }),
    }
  )
);
