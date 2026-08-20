import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { GET as GET_RUN, DELETE as DELETE_RUN } from "./runs/[runId]/route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getAgentsForUser: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/remote-exec", () => ({
  requestRemoteExec: vi.fn(),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { requestRemoteExec } = await import("@/lib/realtime/remote-exec");

const authedUser = {
  id: "user-1",
  email: "test@example.com",
  phone: null,
} as any;

const paramsFor = (host: string) => ({ params: Promise.resolve({ host }) });
const runParamsFor = (host: string, runId: string) => ({
  params: Promise.resolve({ host, runId }),
});

const agentWithRemoteExec = (host: string) => ({
  id: `agent-${host}`,
  host,
  supportedBackends: ["codex"],
  capabilities: ["remote_exec"],
});

const completedRun = {
  runId: "run-1",
  status: "completed",
  exitCode: 0,
  stdoutTail: "marker.txt\n",
  stderrTail: "",
  truncated: false,
};

describe("/api/agents/[host]/exec", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue(authedUser);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([agentWithRemoteExec("ubuntu")]);
    vi.mocked(requestRemoteExec).mockResolvedValue({
      ok: true,
      action: "exec",
      result: completedRun,
    });
  });

  it("returns 401 passthrough when unauthenticated", async () => {
    vi.mocked(getActiveSubscriptionUser).mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }) as any,
    );
    const req = createMockRequest({ method: "POST", body: { command: "ls" } });
    const res = await POST(req, paramsFor("ubuntu"));

    expect(res.status).toBe(401);
    expect(requestRemoteExec).not.toHaveBeenCalled();
  });

  it("returns 404 when the daemon is not connected", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([]);
    const req = createMockRequest({ method: "POST", body: { command: "ls" } });
    const res = await POST(req, paramsFor("ghost"));
    const data = await extractJson(res);

    expect(res.status).toBe(404);
    expect(data.error).toMatch(/not connected/);
    expect(requestRemoteExec).not.toHaveBeenCalled();
  });

  it("returns 409 when the daemon lacks the remote_exec capability", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-old",
        host: "ubuntu",
        supportedBackends: ["codex"],
        capabilities: ["custom_commands"],
      },
    ]);
    const req = createMockRequest({ method: "POST", body: { command: "ls" } });
    const res = await POST(req, paramsFor("ubuntu"));
    const data = await extractJson(res);

    expect(res.status).toBe(409);
    // The message must point at both remedies: the daemon may be old, or it may
    // have opted out. Blaming only the version sends people down the wrong path.
    expect(data.error).toMatch(/remote exec/);
    expect(data.error).toMatch(/upgrade/);
    expect(data.error).toMatch(/remote_exec: false/);
    expect(requestRemoteExec).not.toHaveBeenCalled();
  });

  it("forwards argv and workspace to the daemon and returns the run", async () => {
    const req = createMockRequest({
      method: "POST",
      body: { command: "ls", args: ["."], workspace: "/home/duino/ws/holomotion" },
    });
    const res = await POST(req, paramsFor("ubuntu"));
    const data = await extractJson(res);

    expect(res.status).toBe(200);
    expect(data).toEqual(completedRun);
    expect(requestRemoteExec).toHaveBeenCalledWith({
      userId: "user-1",
      agentHost: "ubuntu",
      action: "exec",
      args: {
        command: "ls",
        args: ["."],
        workspace: "/home/duino/ws/holomotion",
        timeoutMs: 30_000,
      },
      timeoutMs: 35_000,
    });
  });

  it("waits longer than the daemon so a slow run still returns a snapshot", async () => {
    const req = createMockRequest({
      method: "POST",
      body: { command: "sleep", args: ["100"], timeoutMs: 90_000 },
    });
    await POST(req, paramsFor("ubuntu"));

    const call = vi.mocked(requestRemoteExec).mock.calls[0][0];
    expect(call.args?.timeoutMs).toBe(90_000);
    expect(call.timeoutMs).toBeGreaterThan(90_000);
  });

  it("rejects a missing command and an over-long timeout", async () => {
    const missing = await POST(
      createMockRequest({ method: "POST", body: { args: ["."] } }),
      paramsFor("ubuntu"),
    );
    expect(missing.status).toBe(400);

    const tooLong = await POST(
      createMockRequest({ method: "POST", body: { command: "ls", timeoutMs: 999_999 } }),
      paramsFor("ubuntu"),
    );
    expect(tooLong.status).toBe(400);
    expect(requestRemoteExec).not.toHaveBeenCalled();
  });

  it("maps a daemon timeout to 504 and a remote error to 502", async () => {
    vi.mocked(requestRemoteExec).mockResolvedValueOnce({
      ok: false,
      reason: "timeout",
      message: "daemon did not respond within 35000ms",
    });
    const timedOut = await POST(
      createMockRequest({ method: "POST", body: { command: "ls" } }),
      paramsFor("ubuntu"),
    );
    expect(timedOut.status).toBe(504);

    vi.mocked(requestRemoteExec).mockResolvedValueOnce({
      ok: false,
      reason: "remote_error",
      message: "workspace does not exist: /nope",
    });
    const failed = await POST(
      createMockRequest({ method: "POST", body: { command: "ls", workspace: "/nope" } }),
      paramsFor("ubuntu"),
    );
    const failedData = await extractJson(failed);
    expect(failed.status).toBe(502);
    expect(failedData.error).toMatch(/workspace does not exist/);
  });

  it("maps an exhausted per-user concurrency budget to 429", async () => {
    vi.mocked(requestRemoteExec).mockResolvedValueOnce({
      ok: false,
      reason: "too_many_inflight",
      message: "too many concurrent remote exec requests (limit 8); retry shortly",
    });

    const res = await POST(
      createMockRequest({ method: "POST", body: { command: "ls" } }),
      paramsFor("ubuntu"),
    );
    const data = await extractJson(res);

    expect(res.status).toBe(429);
    expect(data.error).toMatch(/too many concurrent/);
  });

  it("cancels a run via DELETE and allows for the daemon's kill grace period", async () => {
    vi.mocked(requestRemoteExec).mockResolvedValue({
      ok: true,
      action: "cancel",
      result: { runId: "run-9", status: "cancelled", signal: "SIGTERM" },
    });

    const req = createMockRequest({ method: "DELETE" });
    const res = await DELETE_RUN(req, runParamsFor("ubuntu", "run-9"));
    const data = await extractJson(res);

    expect(res.status).toBe(200);
    expect(data.status).toBe("cancelled");
    const call = vi.mocked(requestRemoteExec).mock.calls[0][0];
    expect(call.action).toBe("cancel");
    expect(call.args).toEqual({ runId: "run-9" });
    expect(call.timeoutMs).toBeGreaterThan(10_000);
  });

  it("rejects DELETE for a daemon without the capability", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: "agent-old", host: "ubuntu", supportedBackends: ["codex"], capabilities: [] },
    ]);

    const res = await DELETE_RUN(
      createMockRequest({ method: "DELETE" }),
      runParamsFor("ubuntu", "run-9"),
    );

    expect(res.status).toBe(409);
    expect(requestRemoteExec).not.toHaveBeenCalled();
  });

  it("looks up a run snapshot by id", async () => {
    vi.mocked(requestRemoteExec).mockResolvedValue({
      ok: true,
      action: "status",
      result: { ...completedRun, runId: "run-9" },
    });

    const req = createMockRequest({ method: "GET" });
    const res = await GET_RUN(req, runParamsFor("ubuntu", "run-9"));
    const data = await extractJson(res);

    expect(res.status).toBe(200);
    expect(data.runId).toBe("run-9");
    expect(requestRemoteExec).toHaveBeenCalledWith({
      userId: "user-1",
      agentHost: "ubuntu",
      action: "status",
      args: { runId: "run-9" },
      timeoutMs: 10_000,
    });
  });
});
