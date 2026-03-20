import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

import { createMockRequest } from "@/__tests__/helpers";
import { ATTACHMENT_AUTH_COOKIE_NAME } from "./token-storage";

vi.mock("./service", () => ({
  authenticateToken: vi.fn(),
}));

const { getAuthUser } = await import("./middleware");
const { resolveAuthToken } = await import("./middleware");
const { authenticateToken } = await import("./service");

describe("auth middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("authenticates bearer tokens from the authorization header", async () => {
    vi.mocked(authenticateToken).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
    });

    const user = await getAuthUser(
      createMockRequest({
        token: "header-token",
      }),
    );

    expect(user?.id).toBe("user-1");
    expect(authenticateToken).toHaveBeenCalledWith("header-token");
  });

  it("accepts the attachment auth cookie for protected attachment downloads", async () => {
    const token = resolveAuthToken(
      {
        headers: new Headers({
          cookie: `${ATTACHMENT_AUTH_COOKIE_NAME}=cookie-token`,
        }),
        cookies: {
          get: (name: string) =>
            name === ATTACHMENT_AUTH_COOKIE_NAME
              ? { name: ATTACHMENT_AUTH_COOKIE_NAME, value: "cookie-token" }
              : undefined,
        },
        nextUrl: {
          pathname: "/api/tasks/task-1/attachments/att-1",
        },
      } as NextRequest,
    );

    expect(token).toBe("cookie-token");
  });

  it("does not use the attachment auth cookie for unrelated routes", async () => {
    vi.mocked(authenticateToken).mockResolvedValue({
      id: "user-3",
      email: "ignored@example.com",
      phone: null,
    });

    const user = await getAuthUser(
      {
        headers: new Headers({
          cookie: `${ATTACHMENT_AUTH_COOKIE_NAME}=cookie-token`,
        }),
        cookies: {
          get: () => ({ name: ATTACHMENT_AUTH_COOKIE_NAME, value: "cookie-token" }),
        },
        nextUrl: {
          pathname: "/api/tasks",
        },
      } as NextRequest,
    );

    expect(user).toBeNull();
    expect(authenticateToken).not.toHaveBeenCalled();
  });
});
