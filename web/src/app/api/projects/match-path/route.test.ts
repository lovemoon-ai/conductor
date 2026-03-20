import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "@/app/api/projects/match-path/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/subscription/service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/subscription/service")>();
  return {
    ...mod,
    checkAndUpdateExpiredSubscription: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    project: {
      findMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

const { db } = await import("@/lib/db");

describe("/api/projects/match-path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.user.findUnique).mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      phone: null,
      subscriptionStatus: "ACTIVE",
      subscriptionTier: "PLUS",
      subscriptionEndsAt: new Date(Date.now() + 86400000),
      trialEndsAt: null,
      lastPaymentAt: null,
    } as any);
  });

  it("should return 401 when not authenticated", async () => {
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(null);

    const request = createMockRequest({
      method: "POST",
      body: { hostname: "devbox", path: "/Users/duo/ws/conductor" },
    });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(401);
    expect(data.error).toBe("Unauthorized");
  });

  it("should return 400 when hostname or path missing", async () => {
    const mockUser = { id: "user-1", email: "test@example.com", phone: null };
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

    const token = createTestToken("user-1");
    const request = createMockRequest({
      method: "POST",
      token,
      body: { hostname: "devbox" },
    });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(400);
    expect(data.error).toBe("hostname and path are required");
  });

  it("should match project when path is within bound local path", async () => {
    const mockUser = { id: "user-1", email: "test@example.com", phone: null };
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

    vi.mocked(db.project.findMany).mockResolvedValue([
      {
        id: "proj-1",
        name: "Project 1",
        userId: "user-1",
        metadata: JSON.stringify({
          localPaths: {
            devbox: "/Users/duo/ws/conductor",
          },
        }),
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      },
    ]);

    const token = createTestToken("user-1");
    const request = createMockRequest({
      method: "POST",
      token,
      body: { hostname: "devbox", path: "/Users/duo/ws/conductor/web" },
    });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.project.id).toBe("proj-1");
    expect(data.matched_path).toBe("/Users/duo/ws/conductor");
  });

  it("should return null when no project matches", async () => {
    const mockUser = { id: "user-1", email: "test@example.com", phone: null };
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

    vi.mocked(db.project.findMany).mockResolvedValue([
      {
        id: "proj-1",
        name: "Project 1",
        userId: "user-1",
        metadata: JSON.stringify({
          localPaths: {
            devbox: "/Users/duo/ws/conductor",
          },
        }),
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      },
    ]);

    const token = createTestToken("user-1");
    const request = createMockRequest({
      method: "POST",
      token,
      body: { hostname: "devbox", path: "/tmp/other" },
    });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.project).toBeNull();
    expect(data.matched_path).toBeNull();
  });

  it("should match project with default local path when hostname key is missing", async () => {
    const mockUser = { id: "user-1", email: "test@example.com", phone: null };
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

    vi.mocked(db.project.findMany).mockResolvedValue([
      {
        id: "proj-1",
        name: "Project 1",
        userId: "user-1",
        metadata: JSON.stringify({
          localPaths: {
            default: "/Users/duo/ws/conductor",
          },
        }),
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      },
    ]);

    const token = createTestToken("user-1");
    const request = createMockRequest({
      method: "POST",
      token,
      body: { hostname: "some-daemon", path: "/Users/duo/ws/conductor/web" },
    });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.project.id).toBe("proj-1");
    expect(data.matched_path).toBe("/Users/duo/ws/conductor");
  });
});
