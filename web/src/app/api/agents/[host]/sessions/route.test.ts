import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/agents/backend-sessions", () => ({
  listBackendSessions: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    task: { findMany: vi.fn() },
    project: { findMany: vi.fn() },
  },
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { listBackendSessions } = await import("@/lib/agents/backend-sessions");
const { db } = await import("@/lib/db");

const authedUser = {
  id: "user-1",
  email: "test@example.com",
  phone: null,
} as any;

const paramsFor = (host: string) => ({ params: Promise.resolve({ host }) });

const sessionEntry = (overrides: Record<string, unknown> = {}) => ({
  backend: "claude",
  session_id: "sess-1",
  session_file_path: "/home/u/.claude/projects/x/sess-1.jsonl",
  cwd: "/home/u/repo",
  title: "fix login bug",
  updated_at: "2026-09-01T10:00:00.000Z",
  ...overrides,
});

describe("GET /api/agents/[host]/sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue(authedUser);
    vi.mocked(listBackendSessions).mockResolvedValue({
      ok: true,
      result: { request_id: "req-1", sessions: [sessionEntry()], errors: [] },
    });
    vi.mocked(db.task.findMany).mockResolvedValue([]);
    vi.mocked(db.project.findMany).mockResolvedValue([]);
  });

  it("returns 401 passthrough when unauthenticated", async () => {
    vi.mocked(getActiveSubscriptionUser).mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }) as any,
    );
    const res = await GET(createMockRequest({ method: "GET" }), paramsFor("daemon-a"));
    expect(res.status).toBe(401);
    expect(listBackendSessions).not.toHaveBeenCalled();
  });

  it("lists sessions with linked_task_id and project_id annotations", async () => {
    vi.mocked(listBackendSessions).mockResolvedValueOnce({
      ok: true,
      result: {
        request_id: "req-1",
        sessions: [
          sessionEntry({ session_id: "sess-1", cwd: "/home/u/repo/sub" }),
          sessionEntry({
            backend: "codex",
            session_id: "sess-2",
            cwd: "/home/u/repobis",
            updated_at: "2026-08-31T10:00:00.000Z",
          }),
        ],
        errors: [{ backend: "kimi", message: "not installed" }],
      },
    });
    vi.mocked(db.task.findMany).mockResolvedValueOnce([
      { id: "task-1", sessionId: "sess-1" },
    ] as any);
    vi.mocked(db.project.findMany).mockResolvedValueOnce([
      { id: "proj-outer", workspacePath: "/home/u/repo" },
      { id: "proj-inner", workspacePath: "/home/u/repo/sub" },
    ] as any);

    const req = createMockRequest({
      method: "GET",
      url: "http://localhost:6152/api/agents/daemon-a/sessions?backends=claude,codex&limit=20",
    });
    const res = await GET(req, paramsFor("daemon-a"));
    const data = await extractJson(res);

    expect(res.status).toBe(200);
    // Daemon ordering is preserved; longest-prefix project match wins and
    // `/home/u/repobis` must NOT match workspace `/home/u/repo`.
    expect(data.sessions.map((s: any) => s.session_id)).toEqual(["sess-1", "sess-2"]);
    expect(data.sessions[0]).toMatchObject({
      backend: "claude",
      linked_task_id: "task-1",
      project_id: "proj-inner",
    });
    expect(data.sessions[1]).toMatchObject({
      backend: "codex",
      linked_task_id: null,
      project_id: null,
    });
    expect(data.errors).toEqual([{ backend: "kimi", message: "not installed" }]);
    expect(listBackendSessions).toHaveBeenCalledWith({
      userId: "user-1",
      agentHost: "daemon-a",
      backends: ["claude", "codex"],
      limit: 20,
    });
    expect(db.task.findMany).toHaveBeenCalledWith({
      where: { sessionId: { in: ["sess-1", "sess-2"] }, project: { userId: "user-1" } },
      select: { id: true, sessionId: true },
      orderBy: { updatedAt: "desc" },
    });
    expect(db.project.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", daemonHost: "daemon-a", workspacePath: { not: null } },
      select: { id: true, workspacePath: true },
    });
  });

  it("omits errors field when the daemon reported none", async () => {
    const res = await GET(createMockRequest({ method: "GET" }), paramsFor("daemon-a"));
    const data = await extractJson(res);

    expect(res.status).toBe(200);
    expect(data.sessions).toHaveLength(1);
    expect(data).not.toHaveProperty("errors");
  });

  it("returns 404 when the daemon is offline", async () => {
    vi.mocked(listBackendSessions).mockResolvedValueOnce({
      ok: false,
      reason: "daemon_offline",
    });
    const res = await GET(createMockRequest({ method: "GET" }), paramsFor("daemon-a"));
    const data = await extractJson(res);

    expect(res.status).toBe(404);
    expect(data).toEqual({ error: "daemon_offline" });
  });

  it("returns 409 when the daemon lacks the session-list capability", async () => {
    vi.mocked(listBackendSessions).mockResolvedValueOnce({
      ok: false,
      reason: "capability_missing",
    });
    const res = await GET(createMockRequest({ method: "GET" }), paramsFor("daemon-a"));
    const data = await extractJson(res);

    expect(res.status).toBe(409);
    expect(data).toEqual({ error: "daemon_capability_missing" });
  });

  it("returns 504 when the daemon RPC times out", async () => {
    vi.mocked(listBackendSessions).mockResolvedValueOnce({
      ok: false,
      reason: "timeout",
    });
    const res = await GET(createMockRequest({ method: "GET" }), paramsFor("daemon-a"));
    const data = await extractJson(res);

    expect(res.status).toBe(504);
    expect(data).toEqual({ error: "daemon_timeout" });
  });

  it("rejects malformed backends and limit query params", async () => {
    for (const query of ["backends=bad/backend", "backends=,,,", "limit=0", "limit=abc"]) {
      const req = createMockRequest({
        method: "GET",
        url: `http://localhost:6152/api/agents/daemon-a/sessions?${query}`,
      });
      const res = await GET(req, paramsFor("daemon-a"));
      expect(res.status).toBe(400);
    }
    expect(listBackendSessions).not.toHaveBeenCalled();
  });
});
