import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockApiGet,
  mockApiPost,
  mockResetApiClient,
  mockClearStoredJwtToken,
  mockGetStoredJwtToken,
  mockStoreJwtToken,
} = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockResetApiClient: vi.fn(),
  mockClearStoredJwtToken: vi.fn(() => {
    localStorage.removeItem("conductor.jwt");
  }),
  mockGetStoredJwtToken: vi.fn<() => string | null>(() => localStorage.getItem("conductor.jwt")),
  mockStoreJwtToken: vi.fn((token: string) => {
    localStorage.setItem("conductor.jwt", token);
  }),
}));

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => ({
    get: mockApiGet,
    post: mockApiPost,
  }),
  createApiClientWithToken: () => ({
    get: mockApiGet,
    post: mockApiPost,
  }),
  resetApiClient: mockResetApiClient,
}));

vi.mock("@/lib/auth/token-storage", () => ({
  clearStoredJwtToken: mockClearStoredJwtToken,
  getStoredJwtToken: mockGetStoredJwtToken,
  storeJwtToken: mockStoreJwtToken,
}));

import { AUTH_SESSION_STORAGE_KEY, AUTH_USER_TOKEN_STORAGE_KEY, useAuthStore } from "./store";

describe("useAuthStore", () => {
  beforeEach(() => {
    mockApiGet.mockReset();
    mockApiPost.mockReset();
    mockResetApiClient.mockReset();
    mockClearStoredJwtToken.mockReset();
    mockGetStoredJwtToken.mockReset();
    mockStoreJwtToken.mockReset();
    localStorage.clear();
    mockClearStoredJwtToken.mockImplementation(() => {
      localStorage.removeItem("conductor.jwt");
    });
    mockGetStoredJwtToken.mockImplementation(() => localStorage.getItem("conductor.jwt"));
    mockStoreJwtToken.mockImplementation((token: string) => {
      localStorage.setItem("conductor.jwt", token);
    });
    useAuthStore.setState({
      session: null,
      isLoading: false,
      error: null,
    });
  });

  it("clears a stale persisted session when no JWT is present", async () => {
    useAuthStore.setState({
      session: {
        jwtToken: "stale-jwt",
        userToken: "stale-user-token",
        user: {
          id: "user-1",
          email: "stale@example.com",
          phone: null,
        },
      },
    });

    await useAuthStore.getState().initFromStorage();

    expect(useAuthStore.getState().session).toBeNull();
    expect(mockClearStoredJwtToken).toHaveBeenCalledTimes(1);
    expect(mockResetApiClient).toHaveBeenCalledTimes(1);
  });

  it("rebuilds session state from the current JWT instead of trusting stale persisted data", async () => {
    mockGetStoredJwtToken.mockReturnValue("fresh-jwt");
    mockApiGet
      .mockResolvedValueOnce({
        user: {
          id: "user-2",
          email: "fresh@example.com",
          phone: null,
        },
      })
      .mockResolvedValueOnce({
        token: "fresh-user-token",
      });

    useAuthStore.setState({
      session: {
        jwtToken: "stale-jwt",
        userToken: "stale-user-token",
        user: {
          id: "user-1",
          email: "stale@example.com",
          phone: null,
        },
      },
    });

    await useAuthStore.getState().initFromStorage();

    expect(mockStoreJwtToken).toHaveBeenCalledWith("fresh-jwt");
    expect(useAuthStore.getState().session).toEqual({
      jwtToken: "fresh-jwt",
      userToken: "fresh-user-token",
      user: {
        id: "user-2",
        email: "fresh@example.com",
        phone: null,
        name: null,
      },
    });
  });

  it("updates the in-memory user from the auth/me response payload", async () => {
    mockApiGet.mockResolvedValueOnce({
      user: {
        id: "user-1",
        email: "updated@example.com",
        phone: null,
      },
    });

    useAuthStore.setState({
      session: {
        jwtToken: "jwt-1",
        userToken: "user-token-1",
        user: {
          id: "user-1",
          email: "before@example.com",
          phone: null,
        },
      },
    });

    await useAuthStore.getState().fetchUser();

    expect(useAuthStore.getState().session?.user).toEqual({
      id: "user-1",
      email: "updated@example.com",
      phone: null,
      name: null,
    });
  });

  it("does not overwrite the current JWT when establishing a new session fails", async () => {
    localStorage.setItem("conductor.jwt", "jwt-a");

    useAuthStore.setState({
      session: {
        jwtToken: "jwt-a",
        userToken: "user-token-a",
        user: {
          id: "user-a",
          email: "a@example.com",
          phone: null,
        },
      },
    });

    mockApiGet.mockResolvedValueOnce({ token: null });
    mockApiPost.mockRejectedValueOnce(new Error("upstream failed"));

    await expect(
      useAuthStore.getState().establishSession("jwt-b", {
        id: "user-b",
        email: "b@example.com",
        phone: null,
      })
    ).rejects.toThrow("Failed to get user token");

    expect(localStorage.getItem("conductor.jwt")).toBe("jwt-a");
    expect(useAuthStore.getState().session).toEqual({
      jwtToken: "jwt-a",
      userToken: "user-token-a",
      user: {
        id: "user-a",
        email: "a@example.com",
        phone: null,
      },
    });
    expect(mockStoreJwtToken).not.toHaveBeenCalledWith("jwt-b");
  });

  it("clears a persisted session when auth validation fails", async () => {
    mockGetStoredJwtToken.mockReturnValue("jwt-stale");
    mockApiGet.mockRejectedValueOnce(new Error("Unauthorized"));

    useAuthStore.setState({
      session: {
        jwtToken: "jwt-stale",
        userToken: "user-token-stale",
        user: {
          id: "user-1",
          email: "stale@example.com",
          phone: null,
        },
      },
    });

    await useAuthStore.getState().initFromStorage();

    expect(mockClearStoredJwtToken).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().session).toBeNull();
    expect(mockResetApiClient).toHaveBeenCalledTimes(1);
  });

  it("clears a persisted session when auth payload contains null user", async () => {
    mockGetStoredJwtToken.mockReturnValue("jwt-stale");
    mockApiGet.mockResolvedValueOnce({ user: null });

    useAuthStore.setState({
      session: {
        jwtToken: "jwt-stale",
        userToken: "user-token-stale",
        user: {
          id: "user-1",
          email: "stale@example.com",
          phone: null,
        },
      },
    });

    await useAuthStore.getState().initFromStorage();

    expect(mockClearStoredJwtToken).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().session).toBeNull();
    expect(mockResetApiClient).toHaveBeenCalledTimes(1);
  });

  it("logs out when /auth/tokens/latest returns 401 and create-token also fails", async () => {
    // Storage has a JWT but no in-memory session, so fetchUserToken is forced
    // to run instead of trusting a previously-cached userToken.
    mockGetStoredJwtToken.mockReturnValue("jwt-fresh");
    mockApiGet
      // /auth/me succeeds with a valid user
      .mockResolvedValueOnce({
        user: {
          id: "user-1",
          email: "u@example.com",
          phone: null,
        },
      })
      // /auth/tokens/latest rejects with a 401-ish error (ApiClient throws)
      .mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { status: 401 }));
    // POST /auth/tokens fallback also fails (any error)
    mockApiPost.mockRejectedValueOnce(new Error("token endpoint unreachable"));

    // No prior in-memory session — buildSession cannot reuse a userToken.
    useAuthStore.setState({ session: null });

    await useAuthStore.getState().initFromStorage();

    expect(useAuthStore.getState().session).toBeNull();
    expect(mockClearStoredJwtToken).toHaveBeenCalled();
  });

  it("fully clears auth storage on logout", () => {
    localStorage.setItem("conductor.jwt", "jwt-1");
    localStorage.setItem(AUTH_SESSION_STORAGE_KEY, '{"state":{"session":{"jwtToken":"jwt-1"}},"version":0}');
    localStorage.setItem(AUTH_USER_TOKEN_STORAGE_KEY, "user-token-1");

    useAuthStore.setState({
      session: {
        jwtToken: "jwt-1",
        userToken: "user-token-1",
        user: {
          id: "user-1",
          email: "test@example.com",
          phone: null,
        },
      },
    });

    useAuthStore.getState().logout();

    expect(useAuthStore.getState().session).toBeNull();
    expect(localStorage.getItem("conductor.jwt")).toBeNull();
    expect(localStorage.getItem(AUTH_SESSION_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(AUTH_USER_TOKEN_STORAGE_KEY)).toBeNull();
    expect(mockClearStoredJwtToken).toHaveBeenCalledTimes(1);
    expect(mockResetApiClient).toHaveBeenCalledTimes(1);
  });
});
