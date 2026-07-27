import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/tasks/[taskId]/unachieve/route";
import { createMockRequest, createTestToken, extractJson } from "@/__tests__/helpers";
import * as authService from "@/lib/auth/service";

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getAgentsForUser: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("@/lib/subscription/service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/subscription/service")>();
  return { ...mod, checkAndUpdateExpiredSubscription: vi.fn() };
});

vi.mock("@/lib/db", () => ({
  db: {
    task: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

const { db } = await import("@/lib/db");
const { realtimeHub } = await import("@/lib/realtime/hub");

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

const achievedTask = {
  id: "ai-1",
  projectId: "proj-1",
  taskType: "ai_task",
  status: "killed",
  agentHost: "daemon-a",
  executionHost: "daemon-a",
  backendType: "codex",
  metadata: null,
  achievedAt: new Date("2024-01-01T00:00:00.000Z"),
  project: { daemonHost: "daemon-a" },
};

const callUnachieve = async (body: Record<string, unknown> = {}, taskId = "ai-1") =>
  POST(
    createMockRequest({
      method: "POST",
      url: `http://localhost:6152/api/tasks/${taskId}/unachieve`,
      body,
      token: createTestToken(ACTIVE_USER.id),
    }),
    { params: Promise.resolve({ taskId }) },
  );

describe("POST /api/tasks/[taskId]/unachieve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authService, "authenticateToken").mockResolvedValue({
      id: ACTIVE_USER.id,
      email: ACTIVE_USER.email,
      phone: ACTIVE_USER.phone,
    } as any);
    vi.mocked(db.user.findUnique).mockResolvedValue(ACTIVE_USER as any);
    vi.mocked(db.task.findFirst).mockResolvedValue(achievedTask as any);
  });

  it("recommends inplace resume when the original daemon is online", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "a", host: "daemon-a", supportedBackends: ["codex"], capabilities: [] },
    ] as any);

    const res = await callUnachieve();
    expect(res.status).toBe(200);
    const body = await extractJson(res);
    expect(body).toMatchObject({ strategy: "inplace", agentHost: "daemon-a" });
  });

  it("resolves a manual-fire task back to metadata.daemonName", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      ...achievedTask,
      agentHost: "conductor-fire-session-1",
      executionHost: "conductor-fire-session-1",
      metadata: JSON.stringify({ daemonName: "daemon-origin" }),
      project: { daemonHost: null },
    } as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "origin",
        host: "daemon-origin",
        supportedBackends: ["codex"],
        capabilities: [],
      },
    ] as any);

    const res = await callUnachieve();
    expect(res.status).toBe(200);
    expect(await extractJson(res)).toMatchObject({
      strategy: "inplace",
      agentHost: "daemon-origin",
    });
  });

  it("asks the client to pick a daemon when the original is offline", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "b", host: "daemon-b", supportedBackends: ["codex"], capabilities: [] },
    ] as any);

    const res = await callUnachieve();
    expect(res.status).toBe(409);
    const body = await extractJson(res);
    expect(body.code).toBe("daemon_offline");
    expect(body.candidates).toEqual([
      expect.objectContaining({ host: "daemon-b" }),
    ]);
  });

  it("uses new_task when the user picks a different online daemon", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "b", host: "daemon-b", supportedBackends: ["codex"], capabilities: [] },
    ] as any);

    const res = await callUnachieve({ agent_host: "daemon-b" });
    expect(res.status).toBe(200);
    const body = await extractJson(res);
    expect(body).toMatchObject({ strategy: "new_task", agentHost: "daemon-b" });
  });

  it("rejects a selected daemon that is offline", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([] as any);
    const res = await callUnachieve({ agent_host: "daemon-z" });
    expect(res.status).toBe(409);
  });

  it("409s when the task is not achieved", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      ...achievedTask,
      achievedAt: null,
    } as any);
    const res = await callUnachieve();
    expect(res.status).toBe(409);
  });

  it("404s for an unknown task", async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue(null);
    const res = await callUnachieve({}, "missing");
    expect(res.status).toBe(404);
  });
});
