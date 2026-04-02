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
    defaultProject: {
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
    vi.mocked(db.defaultProject.findMany).mockResolvedValue([]);
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

  it("should return 400 when daemon host or path missing", async () => {
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
    expect(data.error).toBe("daemonHost and path are required");
  });

  it("should match project when path is within bound local path", async () => {
    const mockUser = { id: "user-1", email: "test@example.com", phone: null };
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

    vi.mocked(db.project.findMany).mockResolvedValue([
      {
        id: "proj-1",
        name: "Project 1",
        userId: "user-1",
        daemonHost: "devbox",
        workspacePath: "/Users/duo/ws/conductor",
        repoRoot: "/Users/duo/ws/conductor",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        metadata: null,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      },
    ]);

    const token = createTestToken("user-1");
    const request = createMockRequest({
      method: "POST",
      token,
      body: { daemonHost: "devbox", path: "/Users/duo/ws/conductor/web" },
    });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.project.id).toBe("proj-1");
    expect(data.matched_path).toBe("/Users/duo/ws/conductor");
  });

  it("should match legacy metadata.localPaths when workspacePath is missing", async () => {
    const mockUser = { id: "user-1", email: "test@example.com", phone: null };
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

    vi.mocked(db.project.findMany).mockResolvedValue([
      {
        id: "proj-legacy",
        name: "Legacy Project",
        userId: "user-1",
        daemonHost: "devbox",
        workspacePath: null,
        repoRoot: null,
        worktreeBranch: null,
        lastCommit: null,
        fileCount: null,
        metadata: JSON.stringify({
          localPaths: {
            devbox: "/Users/duo/ws/legacy",
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
      body: { daemonHost: "devbox", path: "/Users/duo/ws/legacy/web" },
    });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.project.id).toBe("proj-legacy");
    expect(data.matched_path).toBe("/Users/duo/ws/legacy");
  });

  it("should match pending binding candidates when workspacePath is missing", async () => {
    const mockUser = { id: "user-1", email: "test@example.com", phone: null };
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

    vi.mocked(db.project.findMany).mockResolvedValue([
      {
        id: "proj-pending",
        name: "Pending Project",
        userId: "user-1",
        daemonHost: null,
        workspacePath: null,
        repoRoot: null,
        worktreeBranch: null,
        lastCommit: null,
        fileCount: null,
        metadata: JSON.stringify({
          bindingCandidate: {
            daemonHost: "devbox",
            workspacePath: "/Users/duo/ws/pending",
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
      body: { daemonHost: "devbox", path: "/Users/duo/ws/pending/web" },
    });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.project.id).toBe("proj-pending");
    expect(data.matched_path).toBe("/Users/duo/ws/pending");
  });

  it("should prefer confirmed bindings over newer pending candidates for the same path", async () => {
    const mockUser = { id: "user-1", email: "test@example.com", phone: null };
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

    vi.mocked(db.project.findMany).mockResolvedValue([
      {
        id: "proj-pending",
        name: "Pending Project",
        userId: "user-1",
        daemonHost: null,
        workspacePath: null,
        repoRoot: null,
        worktreeBranch: null,
        lastCommit: null,
        fileCount: null,
        metadata: JSON.stringify({
          bindingCandidate: {
            daemonHost: "devbox",
            workspacePath: "/Users/duo/ws/conductor",
          },
        }),
        createdAt: new Date("2024-01-02"),
        updatedAt: new Date("2024-01-03"),
      },
      {
        id: "proj-confirmed",
        name: "Confirmed Project",
        userId: "user-1",
        daemonHost: "devbox",
        workspacePath: "/Users/duo/ws/conductor",
        repoRoot: "/Users/duo/ws/conductor",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        metadata: null,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      },
    ]);

    const token = createTestToken("user-1");
    const request = createMockRequest({
      method: "POST",
      token,
      body: { daemonHost: "devbox", path: "/Users/duo/ws/conductor/web" },
    });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.project.id).toBe("proj-confirmed");
    expect(data.matched_path).toBe("/Users/duo/ws/conductor");
  });

  it("should not treat daemonless workspace rows as confirmed bindings", async () => {
    const mockUser = { id: "user-1", email: "test@example.com", phone: null };
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

    vi.mocked(db.project.findMany).mockResolvedValue([
      {
        id: "proj-legacy",
        name: "Legacy Workspace Row",
        userId: "user-1",
        daemonHost: null,
        workspacePath: "/Users/duo/ws/conductor",
        repoRoot: null,
        worktreeBranch: null,
        lastCommit: null,
        fileCount: null,
        metadata: null,
        createdAt: new Date("2024-01-03"),
        updatedAt: new Date("2024-01-03"),
      },
      {
        id: "proj-confirmed",
        name: "Confirmed Project",
        userId: "user-1",
        daemonHost: "devbox",
        workspacePath: "/Users/duo/ws/conductor",
        repoRoot: "/Users/duo/ws/conductor",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        metadata: null,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      },
    ]);

    const token = createTestToken("user-1");
    const request = createMockRequest({
      method: "POST",
      token,
      body: { daemonHost: "devbox", path: "/Users/duo/ws/conductor/web" },
    });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.project.id).toBe("proj-confirmed");
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
        daemonHost: "devbox",
        workspacePath: "/Users/duo/ws/conductor",
        repoRoot: "/Users/duo/ws/conductor",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        metadata: null,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
      },
    ]);

    const token = createTestToken("user-1");
    const request = createMockRequest({
      method: "POST",
      token,
      body: { daemonHost: "devbox", path: "/tmp/other" },
    });
    const response = await POST(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.project).toBeNull();
    expect(data.matched_path).toBeNull();
  });

  it("should accept hostname as daemon host alias", async () => {
    const mockUser = { id: "user-1", email: "test@example.com", phone: null };
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

    vi.mocked(db.project.findMany).mockResolvedValue([
      {
        id: "proj-1",
        name: "Project 1",
        userId: "user-1",
        daemonHost: "devbox",
        workspacePath: "/Users/duo/ws/conductor",
        repoRoot: "/Users/duo/ws/conductor",
        worktreeBranch: "main",
        lastCommit: "abc",
        fileCount: 10,
        metadata: null,
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
});
