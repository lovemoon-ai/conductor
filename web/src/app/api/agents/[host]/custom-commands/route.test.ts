import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { POST } from "./run/route";
import { GET as GET_RUN } from "./runs/[runId]/route";
import { createMockRequest, extractJson } from "@/__tests__/helpers";

vi.mock("@/lib/auth/middleware", () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock("@/lib/realtime/hub", () => ({
  realtimeHub: {
    getAgentsForUser: vi.fn(),
  },
}));

vi.mock("@/lib/realtime/custom-commands", () => ({
  requestCustomCommands: vi.fn(),
}));

const { getActiveSubscriptionUser } = await import("@/lib/auth/middleware");
const { realtimeHub } = await import("@/lib/realtime/hub");
const { requestCustomCommands } = await import("@/lib/realtime/custom-commands");

const authedUser = {
  id: "user-1",
  email: "test@example.com",
  phone: null,
} as any;

const paramsFor = (host: string) => ({ params: Promise.resolve({ host }) });
const runParamsFor = (host: string, runId: string) => ({
  params: Promise.resolve({ host, runId }),
});

const agentWithCustomCommands = (host: string) => ({
  id: `agent-${host}`,
  host,
  supportedBackends: ["codex"],
  capabilities: ["custom_commands"],
});

describe("/api/agents/[host]/custom-commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue(authedUser);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([agentWithCustomCommands("daemon-a")]);
    vi.mocked(requestCustomCommands).mockResolvedValue({
      ok: true,
      action: "list",
      result: { commands: [{ key: "refresh-cache", running: false }] },
    });
  });

  it("returns 401 passthrough when unauthenticated", async () => {
    vi.mocked(getActiveSubscriptionUser).mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }) as any,
    );
    const req = createMockRequest({ method: "GET" });
    const res = await GET(req, paramsFor("daemon-a"));
    expect(res.status).toBe(401);
    expect(requestCustomCommands).not.toHaveBeenCalled();
  });

  it("returns 409 when daemon lacks custom command capability", async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      {
        id: "agent-old",
        host: "daemon-a",
        supportedBackends: ["codex"],
        capabilities: ["restart_daemon"],
      },
    ]);
    const req = createMockRequest({ method: "GET" });
    const res = await GET(req, paramsFor("daemon-a"));
    const data = await extractJson(res);

    expect(res.status).toBe(409);
    expect(data.error).toMatch(/custom commands/);
    expect(requestCustomCommands).not.toHaveBeenCalled();
  });

  it("lists configured command keys for a daemon", async () => {
    const req = createMockRequest({ method: "GET" });
    const res = await GET(req, paramsFor("daemon-a"));
    const data = await extractJson(res);

    expect(res.status).toBe(200);
    expect(data).toEqual({ commands: [{ key: "refresh-cache", running: false }] });
    expect(requestCustomCommands).toHaveBeenCalledWith({
      userId: "user-1",
      agentHost: "daemon-a",
      action: "list",
      args: undefined,
      timeoutMs: undefined,
    });
  });

  it("runs a configured command by key", async () => {
    vi.mocked(requestCustomCommands).mockResolvedValueOnce({
      ok: true,
      action: "run",
      result: {
        started: true,
        key: "refresh-cache",
        runId: "run-1",
        status: "running",
        startedAt: "2026-05-23T00:00:00.000Z",
      },
    });
    const req = createMockRequest({ method: "POST", body: { key: "refresh-cache" } });
    const res = await POST(req, paramsFor("daemon-a"));
    const data = await extractJson(res);

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ started: true, key: "refresh-cache", runId: "run-1" });
    expect(requestCustomCommands).toHaveBeenCalledWith({
      userId: "user-1",
      agentHost: "daemon-a",
      action: "run",
      args: { key: "refresh-cache" },
      timeoutMs: 10000,
    });
  });

  it("rejects invalid run keys", async () => {
    const req = createMockRequest({ method: "POST", body: { key: "bad/key" } });
    const res = await POST(req, paramsFor("daemon-a"));

    expect(res.status).toBe(400);
    expect(requestCustomCommands).not.toHaveBeenCalled();
  });

  it("returns command run status with output tails", async () => {
    vi.mocked(requestCustomCommands).mockResolvedValueOnce({
      ok: true,
      action: "status",
      result: {
        runId: "run-1",
        key: "refresh-cache",
        status: "completed",
        stdoutTail: "done\n",
        stderrTail: "",
      },
    });
    const req = createMockRequest({ method: "GET" });
    const res = await GET_RUN(req, runParamsFor("daemon-a", encodeURIComponent("run-1")));
    const data = await extractJson(res);

    expect(res.status).toBe(200);
    expect(data).toMatchObject({ runId: "run-1", status: "completed", stdoutTail: "done\n" });
    expect(requestCustomCommands).toHaveBeenCalledWith({
      userId: "user-1",
      agentHost: "daemon-a",
      action: "status",
      args: { runId: "run-1" },
      timeoutMs: 10000,
    });
  });

  it("maps daemon errors to a 502 response", async () => {
    vi.mocked(requestCustomCommands).mockResolvedValueOnce({
      ok: false,
      reason: "remote_error",
      message: "custom command not found: refresh-cache",
    });
    const req = createMockRequest({ method: "POST", body: { key: "refresh-cache" } });
    const res = await POST(req, paramsFor("daemon-a"));
    const data = await extractJson(res);

    expect(res.status).toBe(502);
    expect(data.error).toMatch(/not found/);
  });
});
