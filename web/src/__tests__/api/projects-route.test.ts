import { describe, it, expect, vi, beforeEach } from "vitest";
import { PATCH } from "@/app/api/projects/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

// This file targets the *query-string* PATCH endpoint at `/api/projects?projectId=...`,
// which is the path the web client uses through `useProjectsStore.updateProject`.
// The sibling test file (`projects-projectId-route.test.ts`) covers the
// alternate `/api/projects/[projectId]` path. Both endpoints share
// `readProjectMetadataInput`, but each one duplicates the JSON-stringify and
// `updateMany` plumbing, so we need test coverage on both so future drift
// surfaces in CI.

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
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    defaultProject: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/projects/daemon-binding", () => ({
  ProjectBindingValidationError: class extends Error {
    status = 409;
  },
  validateProjectBindingWithDaemon: vi.fn(),
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getTaskAgentHost: vi.fn().mockReturnValue(null),
  },
}));

const { db } = await import("@/lib/db");

const buildPatchRequest = (projectId: string, body: unknown, token: string) =>
  createMockRequest({
    method: "PATCH",
    token,
    body,
    url: `http://localhost:6152/api/projects?projectId=${encodeURIComponent(projectId)}`,
  });

describe("/api/projects PATCH (query-string variant)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.defaultProject.findUnique).mockResolvedValue(null);
    vi.mocked(db.project.findMany).mockResolvedValue([]);
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

  it("persists and serializes metadata.memos round-trip", async () => {
    // Mirror the production flow: the client PATCHes a `metadata.memos` blob
    // and renders the timeline directly from the response without a refetch.
    const mockUser = { id: "user-1", email: "test@example.com", phone: null };
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: "proj-1",
      name: "Memo Project",
      userId: "user-1",
      daemonHost: "daemon-a",
      workspacePath: "/repo/memo",
      hiddenAt: null,
    } as any);
    vi.mocked(db.project.updateMany).mockResolvedValue({ count: 1 } as any);
    const storedMemos = [
      { id: "m1", content: "first", createdAt: "2026-05-01T08:00:00.000Z" },
      { id: "m2", content: "second", createdAt: "2026-05-02T08:00:00.000Z" },
    ];
    vi.mocked(db.project.findUnique).mockResolvedValue({
      id: "proj-1",
      name: "Memo Project",
      daemonHost: "daemon-a",
      workspacePath: "/repo/memo",
      repoRoot: null,
      worktreeBranch: null,
      lastCommit: null,
      fileCount: null,
      metadata: JSON.stringify({ memos: storedMemos }),
      createdAt: new Date("2026-05-01"),
      updatedAt: new Date("2026-05-02"),
    } as any);

    const token = createTestToken("user-1");
    const request = buildPatchRequest("proj-1", { metadata: { memos: storedMemos } }, token);
    const response = await PATCH(request);
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    // The serialized string came straight from `readProjectMetadataInput`, so
    // the bytes we measure for the size cap are the bytes we hand to Prisma.
    expect(db.project.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: JSON.stringify({ memos: storedMemos }),
        }),
      }),
    );
    expect(data.metadata).toEqual({ memos: storedMemos });
  });

  it("rejects metadata payloads exceeding the 256 KiB cap", async () => {
    const mockUser = { id: "user-1", email: "test@example.com", phone: null };
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

    const token = createTestToken("user-1");
    // 300 KiB ASCII bytes — over the cap before we even touch the DB.
    const oversizedContent = "a".repeat(300 * 1024);
    const request = buildPatchRequest(
      "proj-1",
      {
        metadata: {
          memos: [
            { id: "big", content: oversizedContent, createdAt: "2026-05-01T00:00:00.000Z" },
          ],
        },
      },
      token,
    );
    const response = await PATCH(request);
    const data = await extractJson(response);

    expect(response.status).toBe(400);
    expect(data.error).toMatch(/metadata exceeds/);
    expect(db.project.updateMany).not.toHaveBeenCalled();
  });

  it("rejects multibyte metadata payloads whose UTF-8 size exceeds the cap", async () => {
    // A regression guard for the byte-vs-char trap: each CJK char encodes to
    // 3 UTF-8 bytes. If we ever revert to `string.length` accounting, this
    // payload (≈100K chars ≈ 300 KB UTF-8) would slip past the 256 KiB cap.
    const mockUser = { id: "user-1", email: "test@example.com", phone: null };
    vi.spyOn(authService, "authenticateToken").mockResolvedValue(mockUser);

    const token = createTestToken("user-1");
    const cjkContent = "笔".repeat(100 * 1024);
    const request = buildPatchRequest(
      "proj-1",
      {
        metadata: {
          memos: [
            { id: "cjk", content: cjkContent, createdAt: "2026-05-01T00:00:00.000Z" },
          ],
        },
      },
      token,
    );
    const response = await PATCH(request);
    const data = await extractJson(response);

    expect(response.status).toBe(400);
    expect(data.error).toMatch(/metadata exceeds/);
    expect(db.project.updateMany).not.toHaveBeenCalled();
  });
});
