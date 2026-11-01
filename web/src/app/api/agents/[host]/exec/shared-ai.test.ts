import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRequest } from "@/__tests__/helpers";
import { POST } from "./route";
import { GET as waitRun } from "./runs/[runId]/route";

vi.mock("@/lib/auth/service", () => ({ authenticateToken: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    userToken: { findMany: vi.fn() },
    daemonShare: { findFirst: vi.fn() },
    task: { findFirst: vi.fn() },
    project: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: { getAgentsForUser: vi.fn() },
}));
vi.mock("@/lib/realtime/remote-exec", () => ({ requestRemoteExec: vi.fn() }));

const { db } = await import("@/lib/db");
const { authenticateToken } = await import("@/lib/auth/service");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { requestRemoteExec } = await import("@/lib/realtime/remote-exec");
const { mockPrismaQuery } = await import("@/__tests__/mock-prisma-query");

const guestHost = "shared-alice-mbp";
const binding = { id: "share-1", guestHost, granteeUserId: "user-1" };
const remoteTask = () => ({
  id: "task-1",
  metadata: JSON.stringify({ globalBackend: { host: guestHost, backend: "codex" } }),
  launchConfig: JSON.stringify({
    remoteWorkspace: { host: "own-code", projectId: "p-code", repoRoot: "/repo", workspacePath: "/repo" },
  }),
});
const post = (taskId: string | null = "task-1", host = "own-code") => POST(createMockRequest({
  method: "POST",
  token: "share-token",
  url: `http://localhost/api/agents/${host}/exec`,
  headers: taskId ? { "X-Conductor-Task-Id": taskId } : {},
  body: { command: "pwd", args: [], workspace: "/repo" },
}), { params: Promise.resolve({ host }) });

describe("shared global AI remote API authorization (real auth middleware)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateToken).mockResolvedValue({
      id: "user-1", email: null, phone: null, tokenScope: "daemon_share",
    });
    vi.mocked(db.userToken.findMany).mockResolvedValue([
      { id: "tok-1", userId: "user-1", daemonShareId: "share-1" },
    ] as any);
    mockPrismaQuery(db.daemonShare.findFirst).mockImplementation(async (args: any) =>
      args.where.id === "share-1" ? binding as any : null);
    vi.mocked(db.task.findFirst).mockResolvedValue(remoteTask() as any);
    vi.mocked(db.project.findFirst).mockResolvedValue({ id: "p-code", daemonHost: "own-code" } as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "code-agent", host: "own-code", capabilities: ["remote_exec"], supportedBackends: [] },
    ]);
    vi.mocked(requestRemoteExec).mockResolvedValue({
      ok: true, action: "exec", result: { status: "completed", exitCode: 0, stdoutTail: "/repo" },
    });
  });

  it("executes on the task's own code daemon and can wait for its run", async () => {
    expect((await post()).status).toBe(200);
    expect(requestRemoteExec).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1", agentHost: "own-code", action: "exec",
    }));
    expect(db.task.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "task-1", agentHost: guestHost, project: { userId: "user-1" },
        achievedAt: null, status: { in: ["pending", "init", "running", "unknown", "killing"] },
      }),
    }));

    const response = await waitRun(createMockRequest({
      token: "share-token", url: "http://localhost/api/agents/own-code/exec/runs/run-1",
      headers: { "X-Conductor-Task-Id": "task-1" },
    }), { params: Promise.resolve({ host: "own-code", runId: "run-1" }) });
    expect(response.status).toBe(200);
    expect(requestRemoteExec).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "status", args: { runId: "run-1" },
    }));
  });

  it("requires a task header for a shared token", async () => {
    expect((await post(null)).status).toBe(401);
    expect(db.task.findFirst).not.toHaveBeenCalled();
    expect(requestRemoteExec).not.toHaveBeenCalled();
  });

  it("refuses a missing, finished, archived, foreign, or differently assigned task", async () => {
    // These all fail the ownership/host/status/achievedAt predicates above.
    vi.mocked(db.task.findFirst).mockResolvedValue(null);
    expect((await post()).status).toBe(401);
    expect(requestRemoteExec).not.toHaveBeenCalled();
  });

  it("does not authorize another code daemon with the same task id", async () => {
    expect((await post("task-1", "other-daemon")).status).toBe(401);
    expect(requestRemoteExec).not.toHaveBeenCalled();
  });

  it("does not authorize a task assigned to another shared AI", async () => {
    const task = remoteTask();
    task.metadata = JSON.stringify({ globalBackend: { host: "other-shared-ai", backend: "codex" } });
    vi.mocked(db.task.findFirst).mockResolvedValue(task as any);
    expect((await post()).status).toBe(401);
    expect(requestRemoteExec).not.toHaveBeenCalled();
  });

  it("revokes access as soon as the share is revoked", async () => {
    vi.mocked(db.daemonShare.findFirst).mockResolvedValue(null);
    expect((await post()).status).toBe(401);
    expect(requestRemoteExec).not.toHaveBeenCalled();
  });

  it("refuses a shared code daemon", async () => {
    vi.mocked(db.daemonShare.findFirst).mockResolvedValue(binding as any);
    expect((await post()).status).toBe(401);
    expect(requestRemoteExec).not.toHaveBeenCalled();
  });

  it("preserves ordinary remote exec with a full token and no task header", async () => {
    vi.mocked(authenticateToken).mockResolvedValue({ id: "user-1", email: null, phone: null });
    expect((await post(null)).status).toBe(200);
    expect(db.task.findFirst).not.toHaveBeenCalled();
  });
});
