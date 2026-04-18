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

vi.mock("@/features/subscription", () => ({
  SubscriptionBanner: () => <div>subscription-banner</div>,
}));

vi.mock("@/features/auth", async () => {
  const actual = await vi.importActual<typeof import("@/features/auth")>("@/features/auth");
  return {
    ...actual,
    useAuthStore: (selector: (state: typeof mockAuthState) => unknown) => selector(mockAuthState),
  };
});

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
    window.history.replaceState({}, "", "/?token=oauth-jwt");

    render(<Home />);

    await waitFor(() => {
      expect(mockAuthState.establishSession).toHaveBeenCalledWith("oauth-jwt");
    });
    expect(window.location.search).toBe("?token=oauth-jwt");

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

  it("shows a github button in the top-right area", async () => {
    render(<Home />);

    await waitFor(() => {
      expect(mockAuthState.initFromStorage).toHaveBeenCalledTimes(1);
    });

    const githubLink = screen.getByRole("link", { name: "GitHub" });
    expect(githubLink).toHaveAttribute("href", "https://github.com/lovemoon-ai/conductor");
    expect(githubLink).toHaveAttribute("target", "_blank");
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
});
