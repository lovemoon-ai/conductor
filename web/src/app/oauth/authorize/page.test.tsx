import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { replaceMock, mockSearchParams, mockSession, postMock, locationReplaceMock, routerRef, searchParamsRef } =
  vi.hoisted(() => ({
    replaceMock: vi.fn(),
    mockSearchParams: { current: new URLSearchParams() },
    mockSession: { value: null as null | { jwtToken: string } },
    postMock: vi.fn(),
    locationReplaceMock: vi.fn(),
    routerRef: { current: null as any },
    searchParamsRef: { current: null as any },
  }));

// Stable references to avoid retriggering effects across re-renders.
routerRef.current = { replace: replaceMock };
searchParamsRef.current = {
  toString: () => mockSearchParams.current.toString(),
  entries: () => mockSearchParams.current.entries(),
  get: (key: string) => mockSearchParams.current.get(key),
};

vi.mock("next/navigation", () => ({
  useRouter: () => routerRef.current,
  useSearchParams: () => searchParamsRef.current,
}));

vi.mock("@/features/auth/store", () => ({
  useAuthStore: (selector: (s: { session: null | { jwtToken: string }; isLoading: boolean }) => unknown) =>
    selector({ session: mockSession.value, isLoading: false }),
}));

const apiClientRef = { current: null as any };
vi.mock("@/shared/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/shared/api/client")>("@/shared/api/client");
  return {
    ...actual,
    createApiClientWithToken: () => apiClientRef.current,
  };
});

import OAuthAuthorizePage from "./page";

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockSession.value = null;
  mockSearchParams.current = new URLSearchParams();
  apiClientRef.current = {
    post: postMock,
    get: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
  Object.defineProperty(window, "location", {
    value: { replace: locationReplaceMock },
    writable: true,
  });
});

afterEach(() => {
  cleanup();
});

function setQuery(params: Record<string, string>) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) usp.set(k, v);
  mockSearchParams.current = usp;
}

describe("OAuthAuthorizePage", () => {
  it("redirects unauthenticated users to /login with the current relative path as next", async () => {
    setQuery({
      client_id: "arxiv-radar",
      redirect_uri: "https://arxiv-radar.example.com/api/auth/callback",
      state: "csrf-1",
      response_type: "code",
    });

    render(<OAuthAuthorizePage />);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1));
    const arg = replaceMock.mock.calls[0][0] as string;
    expect(arg.startsWith("/login?next=")).toBe(true);
    const next = decodeURIComponent(arg.slice("/login?next=".length));
    expect(next.startsWith("/oauth/authorize?")).toBe(true);
    expect(next).toContain("client_id=arxiv-radar");
    expect(next).toContain("state=csrf-1");
  });

  it("calls /oauth/authorizations and replaces window.location on success", async () => {
    mockSession.value = { jwtToken: "jwt-1" };
    setQuery({
      client_id: "arxiv-radar",
      redirect_uri: "https://arxiv-radar.example.com/api/auth/callback",
      state: "csrf-1",
      response_type: "code",
    });
    postMock.mockResolvedValue({
      redirect_uri: "https://arxiv-radar.example.com/api/auth/callback?code=xyz&state=csrf-1",
    });

    render(<OAuthAuthorizePage />);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith("/oauth/authorizations", {
      client_id: "arxiv-radar",
      redirect_uri: "https://arxiv-radar.example.com/api/auth/callback",
      state: "csrf-1",
      response_type: "code",
    });
    await waitFor(() => expect(locationReplaceMock).toHaveBeenCalledTimes(1));
    expect(locationReplaceMock).toHaveBeenCalledWith(
      "https://arxiv-radar.example.com/api/auth/callback?code=xyz&state=csrf-1",
    );
  });

  it("shows an error when client is not allowed", async () => {
    mockSession.value = { jwtToken: "jwt-1" };
    setQuery({
      client_id: "unknown",
      redirect_uri: "https://example.com/cb",
      state: "x",
    });
    const { ApiRequestError } = await import("@/shared/api/client");
    postMock.mockRejectedValue(
      new ApiRequestError(403, { error: "unknown_client", message: "Unknown client_id" }),
    );

    render(<OAuthAuthorizePage />);

    await waitFor(() =>
      expect(screen.getByText("This app is not allowed to sign in with Conductor.")).toBeTruthy(),
    );
    expect(locationReplaceMock).not.toHaveBeenCalled();
  });

  it("shows an error for invalid redirect URI", async () => {
    mockSession.value = { jwtToken: "jwt-1" };
    setQuery({
      client_id: "arxiv-radar",
      redirect_uri: "https://evil.example/cb",
      state: "x",
    });
    const { ApiRequestError } = await import("@/shared/api/client");
    postMock.mockRejectedValue(
      new ApiRequestError(403, { error: "invalid_redirect_uri", message: "Invalid redirect URI" }),
    );

    render(<OAuthAuthorizePage />);

    await waitFor(() => expect(screen.getByText("Invalid redirect URI.")).toBeTruthy());
    expect(locationReplaceMock).not.toHaveBeenCalled();
  });

  it("re-routes to /login on 401 from authorization API", async () => {
    mockSession.value = { jwtToken: "jwt-stale" };
    setQuery({
      client_id: "arxiv-radar",
      redirect_uri: "https://arxiv-radar.example.com/api/auth/callback",
      state: "x",
    });
    const { ApiRequestError } = await import("@/shared/api/client");
    postMock.mockRejectedValue(new ApiRequestError(401, { error: "Unauthorized" }));

    render(<OAuthAuthorizePage />);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1));
    expect((replaceMock.mock.calls[0][0] as string).startsWith("/login?next=")).toBe(true);
  });

  it("shows error when state is missing", async () => {
    mockSession.value = { jwtToken: "jwt-1" };
    setQuery({
      client_id: "arxiv-radar",
      redirect_uri: "https://arxiv-radar.example.com/api/auth/callback",
    });

    render(<OAuthAuthorizePage />);

    await waitFor(() => expect(screen.getByText("Missing state.")).toBeTruthy());
    expect(postMock).not.toHaveBeenCalled();
  });
});
