import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/tasks/achieved/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/subscription/service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/subscription/service")>();
  return { ...mod, checkAndUpdateExpiredSubscription: vi.fn() };
});

vi.mock("@/lib/db", () => ({
  db: {
    task: { count: vi.fn(), findMany: vi.fn() },
    message: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

const { db } = await import("@/lib/db");

const ACTIVE_USER = {
  id: "user-1",
  email: "test@example.com",
  phone: null,
  subscriptionStatus: "ACTIVE",
  subscriptionTier: "PLUS",
  subscriptionEndsAt: new Date(Date.now() + 86400000),
  trialEndsAt: null,
  lastPaymentAt: null,
};

const achievedRow = {
  id: "ai-1",
  title: "Reading the diffusion paper",
  projectId: "proj-1",
  backendType: "codex",
  agentHost: "daemon-a",
  executionHost: "daemon-a",
  metadata: null,
  status: "killed",
  achievedAt: new Date("2024-03-01T00:00:00.000Z"),
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  project: { name: "Papers", daemonHost: "daemon-a" },
  _count: { messages: 12 },
};

const callSearch = async (qs = "") =>
  GET(
    createMockRequest({
      method: "GET",
      url: `http://localhost:6152/api/tasks/achieved${qs}`,
      token: createTestToken(ACTIVE_USER.id),
    }),
  );

describe("GET /api/tasks/achieved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: ACTIVE_USER.id,
      email: ACTIVE_USER.email,
      phone: ACTIVE_USER.phone,
    } as any);
    vi.mocked(db.user.findUnique).mockResolvedValue(ACTIVE_USER as any);
    vi.mocked(db.task.findMany).mockResolvedValue([achievedRow] as any);
    vi.mocked(db.task.count).mockResolvedValue(1);
    vi.mocked(db.message.findFirst).mockResolvedValue(null as any);
  });

  it("lists achieved tasks scoped to achievedAt != null", async () => {
    const res = await callSearch();
    expect(res.status).toBe(200);
    const body = await extractJson(res);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]).toMatchObject({
      id: "ai-1",
      title: "Reading the diffusion paper",
      projectName: "Papers",
      daemonHost: "daemon-a",
      messageCount: 12,
    });
    expect(body).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 10,
      totalPages: 1,
    });

    const whereArg = vi.mocked(db.task.findMany).mock.calls[0][0] as any;
    expect(whereArg.where.achievedAt).toEqual({ not: null });
    expect(whereArg.orderBy).toEqual({ achievedAt: "desc" });
  });

  it("filters by title/content and returns a snippet for content matches", async () => {
    vi.mocked(db.message.findFirst).mockResolvedValue({
      content: "We discussed the diffusion schedule in depth here.",
    } as any);

    const res = await callSearch("?q=diffusion");
    const body = await extractJson(res);

    const whereArg = vi.mocked(db.task.findMany).mock.calls[0][0] as any;
    expect(whereArg.where.OR).toBeTruthy();
    expect(db.message.findFirst).toHaveBeenCalledWith({
      where: {
        taskId: "ai-1",
        content: { contains: "diffusion" },
      },
      orderBy: { createdAt: "asc" },
      select: { content: true },
    });
    expect(body.tasks[0].snippet).toContain("diffusion");
  });

  it("passes a daemonHost filter through to the project scope", async () => {
    await callSearch("?daemonHost=daemon-a");
    const whereArg = vi.mocked(db.task.findMany).mock.calls[0][0] as any;
    expect(whereArg.where.project).toMatchObject({ daemonHost: "daemon-a" });
  });

  it("filters achieved tasks by project without escaping the user scope", async () => {
    await callSearch("?projectId=proj-1");
    const whereArg = vi.mocked(db.task.findMany).mock.calls[0][0] as any;
    expect(whereArg.where.project).toEqual({
      id: "proj-1",
      userId: ACTIVE_USER.id,
    });
    const countArg = vi.mocked(db.task.count).mock.calls[0][0] as any;
    expect(countArg.where).toEqual(whereArg.where);
  });

  it("filters a merged project group across all member project ids", async () => {
    await callSearch("?projectIds=proj-1,proj-2");
    const whereArg = vi.mocked(db.task.findMany).mock.calls[0][0] as any;
    expect(whereArg.where.project).toEqual({
      id: { in: ["proj-1", "proj-2"] },
      userId: ACTIVE_USER.id,
    });
    const countArg = vi.mocked(db.task.count).mock.calls[0][0] as any;
    expect(countArg.where).toEqual(whereArg.where);
  });

  it("paginates results and caps every page at ten tasks", async () => {
    vi.mocked(db.task.count).mockResolvedValue(25);

    const res = await callSearch("?page=3&limit=100");
    const body = await extractJson(res);

    expect(body).toMatchObject({
      total: 25,
      page: 3,
      pageSize: 10,
      totalPages: 3,
    });
    const findArgs = vi.mocked(db.task.findMany).mock.calls[0][0] as any;
    expect(findArgs.take).toBe(10);
    expect(findArgs.skip).toBe(20);
    const countArgs = vi.mocked(db.task.count).mock.calls[0][0] as any;
    expect(countArgs.where).toEqual(findArgs.where);
  });
});
