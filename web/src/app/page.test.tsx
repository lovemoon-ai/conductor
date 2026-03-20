import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuthState, mockFetch } = vi.hoisted(() => ({
  mockAuthState: {
    session: null as
      | {
          jwtToken: string;
          userToken: string;
          user: {
            id: string;
            email: string | null;
            phone: string | null;
          };
        }
      | null,
    initFromStorage: vi.fn<() => Promise<void>>(),
    establishSession: vi.fn<(jwtToken: string) => Promise<void>>(),
    logout: vi.fn(),
  },
  mockFetch: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/ui/ConductorLogo", () => ({
  ConductorLogo: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("@/components/theme/ThemeToggle", () => ({
  ThemeToggle: () => <div>theme-toggle</div>,
}));

vi.mock("@/components/subscription/SubscriptionBanner", () => ({
  default: () => <div>subscription-banner</div>,
}));

vi.mock("@/lib/conductor/stores/auth", () => ({
  useAuthStore: (selector: (state: typeof mockAuthState) => unknown) => selector(mockAuthState),
}));

import Home from "./page";

function createDeferred() {
  let resolve!: () => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe("Home auth bootstrap", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    mockAuthState.session = null;
    mockAuthState.initFromStorage.mockResolvedValue(undefined);
    mockAuthState.establishSession.mockResolvedValue(undefined);
    mockAuthState.logout.mockImplementation(() => {});
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("waits for oauth bootstrap to succeed before clearing the URL token", async () => {
    const deferred = createDeferred();
    mockAuthState.establishSession.mockReturnValueOnce(deferred.promise);
    window.history.replaceState({}, "", "/?token=oauth-jwt&insufficient_days=1");

    render(<Home />);

    await waitFor(() => {
      expect(mockAuthState.establishSession).toHaveBeenCalledWith("oauth-jwt");
    });
    expect(window.location.search).toBe("?token=oauth-jwt&insufficient_days=1");

    deferred.resolve();

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
      expect(window.location.search).toBe("");
    });
    expect(mockAuthState.logout).not.toHaveBeenCalled();
  });

  it("retries transient oauth bootstrap failures and exposes a manual retry action after exhaustion", async () => {
    vi.useFakeTimers();
    mockAuthState.establishSession.mockRejectedValue(new Error("Failed to get user token"));
    window.history.replaceState({}, "", "/?token=oauth-jwt");

    render(<Home />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockAuthState.establishSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(mockAuthState.establishSession).toHaveBeenCalledTimes(3);

    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("?token=oauth-jwt");
    expect(mockAuthState.logout).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("We couldn't finish signing in automatically.");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
      await Promise.resolve();
    });
    expect(mockAuthState.establishSession).toHaveBeenCalledTimes(4);
  });

  it("clears the oauth token and logs out when bootstrap is unauthorized", async () => {
    mockAuthState.establishSession.mockRejectedValueOnce(new Error("Unauthorized"));
    window.history.replaceState({}, "", "/?token=oauth-jwt");

    render(<Home />);

    await waitFor(() => {
      expect(mockAuthState.logout).toHaveBeenCalledTimes(1);
    });

    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
  });

  it("re-syncs homepage auth when another tab changes auth storage", async () => {
    render(<Home />);

    await waitFor(() => {
      expect(mockAuthState.initFromStorage).toHaveBeenCalledTimes(1);
    });

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "conductor.jwt" }));
    });

    await waitFor(() => {
      expect(mockAuthState.initFromStorage).toHaveBeenCalledTimes(2);
    });
  });

  it("does not issue user requests before stored auth finishes validation", async () => {
    const deferred = createDeferred();
    mockAuthState.session = {
      jwtToken: "stale-jwt",
      userToken: "stale-user-token",
      user: {
        id: "user-1",
        email: "stale@example.com",
        phone: null,
      },
    };
    mockAuthState.initFromStorage.mockReturnValueOnce(deferred.promise);

    render(<Home />);

    await waitFor(() => {
      expect(mockAuthState.initFromStorage).toHaveBeenCalledTimes(1);
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not issue stale-session requests while oauth bootstrap is unresolved", async () => {
    mockAuthState.session = {
      jwtToken: "jwt-a",
      userToken: "user-token-a",
      user: {
        id: "user-a",
        email: "a@example.com",
        phone: null,
      },
    };
    mockAuthState.establishSession.mockRejectedValueOnce(new Error("Failed to get user token"));
    window.history.replaceState({}, "", "/?token=oauth-jwt");

    render(<Home />);

    await waitFor(() => {
      expect(mockAuthState.establishSession).toHaveBeenCalledWith("oauth-jwt");
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("logs out when loading the api token returns unauthorized", async () => {
    mockAuthState.session = {
      jwtToken: "jwt-stale",
      userToken: "user-token-stale",
      user: {
        id: "user-1",
        email: "stale@example.com",
        phone: null,
      },
    };
    mockFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/auth/tokens/latest") {
        return {
          ok: false,
          status: 401,
          json: vi.fn().mockResolvedValue({ error: "Unauthorized" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({}),
      };
    });

    render(<Home />);

    await waitFor(() => {
      expect(mockAuthState.logout).toHaveBeenCalledTimes(1);
    });
  });

  it("logs out instead of showing a create-token error when token creation returns unauthorized", async () => {
    mockAuthState.session = {
      jwtToken: "jwt-valid-then-expired",
      userToken: "user-token-1",
      user: {
        id: "user-1",
        email: "test@example.com",
        phone: null,
      },
    };
    mockFetch.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/auth/tokens/latest") {
        return {
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({ token: null }),
        };
      }
      if (url === "/api/auth/tokens" && init?.method === "POST") {
        return {
          ok: false,
          status: 401,
          json: vi.fn().mockResolvedValue({ error: "Unauthorized" }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({}),
      };
    });

    render(<Home />);

    fireEvent.click(await screen.findByRole("button", { name: "Create Token" }));

    await waitFor(() => {
      expect(mockAuthState.logout).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("Unable to create token.")).toBeNull();
  });
});
