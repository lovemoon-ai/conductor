import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "@/app/api/auth/me/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

describe("/api/auth/me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return user when authenticated", async () => {
    const mockUser = { id: "user-1", email: "test@example.com", phone: null };

    vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

    const token = createTestToken("user-1");
    const request = createMockRequest({ token });
    const response = await GET(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.user).toEqual(mockUser);
  });

  it("should return unauthorized when not authenticated", async () => {
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(null);

    const request = createMockRequest({});
    const response = await GET(request);
    const data = await extractJson(response);

    expect(response.status).toBe(401);
    expect(data.error).toBe("Unauthorized");
  });
});
