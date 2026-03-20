import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { replaceMock, mockNextPath } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  mockNextPath: { value: "/activate?user_code=ABCD-EFGH" },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => ({
    get: (key: string) => (key === "next" ? mockNextPath.value : null),
  }),
}));

vi.mock("@/components/auth/LoginForm", () => ({
  LoginForm: ({ onSuccess }: { onSuccess?: (token: string) => void }) => (
    <button type="button" onClick={() => onSuccess?.("jwt-1")}>
      complete-login
    </button>
  ),
}));

import LoginPage from "./page";

describe("LoginPage", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockNextPath.value = "/activate?user_code=ABCD-EFGH";
  });

  afterEach(() => {
    cleanup();
  });

  it("returns to the provided internal next path after login", () => {
    render(<LoginPage />);

    fireEvent.click(screen.getByRole("button", { name: "complete-login" }));

    expect(replaceMock).toHaveBeenCalledWith("/activate?user_code=ABCD-EFGH");
  });

  it("falls back to the homepage for unsafe next paths", () => {
    mockNextPath.value = "https://evil.example";

    render(<LoginPage />);

    fireEvent.click(screen.getByRole("button", { name: "complete-login" }));

    expect(replaceMock).toHaveBeenCalledWith("/");
  });
});
