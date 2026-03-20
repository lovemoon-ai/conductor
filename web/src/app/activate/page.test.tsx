import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuthState, mockFetch, replaceMock, mockUserCode } = vi.hoisted(() => ({
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
  },
  mockFetch: vi.fn(),
  replaceMock: vi.fn(),
  mockUserCode: { value: "ABCD-EFGH" },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => ({
    get: (key: string) => (key === "user_code" ? mockUserCode.value : null),
  }),
}));

vi.mock("@/lib/conductor/stores/auth", () => ({
  useAuthStore: (selector: (state: typeof mockAuthState) => unknown) => selector(mockAuthState),
}));

import ActivatePage from "./page";

describe("ActivatePage", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    mockAuthState.initFromStorage.mockResolvedValue(undefined);
    mockAuthState.session = null;
    mockUserCode.value = "ABCD-EFGH";
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("redirects unauthenticated pending authorizations to login", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        status: "pending",
        user_code: "ABCD-EFGH",
        cli_version: "0.2.0",
        hostname: "macbook-pro",
        platform: "darwin",
        backend_url: "http://localhost:6152",
        expires_at: "2026-03-20T00:00:00.000Z",
        approved_at: null,
      }),
    });

    render(<ActivatePage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/login?next=%2Factivate%3Fuser_code%3DABCD-EFGH");
    });
  });

  it("shows a minimal success screen after approval", async () => {
    mockAuthState.session = {
      jwtToken: "jwt-1",
      userToken: "user-token-1",
      user: {
        id: "user-1",
        email: "test@example.com",
        phone: null,
      },
    };
    mockFetch.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/auth/device/session")) {
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({
            status: "pending",
            user_code: "ABCD-EFGH",
            cli_version: "0.2.0",
            hostname: "macbook-pro",
            platform: "darwin",
            backend_url: "http://localhost:6152",
            expires_at: "2026-03-20T00:00:00.000Z",
            approved_at: null,
          }),
        };
      }
      if (url === "/api/auth/device/approve") {
        return {
          ok: true,
          json: vi.fn().mockResolvedValue({ ok: true, status: "approved" }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<ActivatePage />);

    fireEvent.click(await screen.findByRole("button", { name: "Authorize this device" }));

    await waitFor(() => {
      expect(screen.getByText("Device authorized, close current page.")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Close me" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Authorize this device" })).toBeNull();
  });
});
