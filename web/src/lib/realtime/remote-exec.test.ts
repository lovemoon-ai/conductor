import { describe, expect, it, vi } from "vitest";
import { RealtimeHub } from "./hub";

/**
 * These exercise the real hub wiring rather than a mocked `requestRemoteExec`:
 * request goes out over a registered agent connection, the daemon's reply is
 * fed back through `resolveRemoteExecResponse`, and the outcome mapping is
 * checked end to end.
 */
vi.mock("./hub", async () => {
  const actual = await vi.importActual<typeof import("./hub")>("./hub");
  const hub = new actual.RealtimeHub();
  return { ...actual, realtimeHub: hub };
});

const { realtimeHub } = await import("./hub");
const { requestRemoteExec } = await import("./remote-exec");

function registerFakeDaemon(
  userId: string,
  host: string,
  onSend: (payload: any) => void,
) {
  const conn = {
    id: `conn-${host}`,
    kind: "agent" as const,
    userId,
    projectIds: [],
    host,
    capabilities: ["remote_exec"],
    send: onSend,
    close: () => {},
  };
  (realtimeHub as RealtimeHub).register(conn);
  return conn;
}

describe("requestRemoteExec over the real hub", () => {
  it("delivers the request to the daemon and resolves with its run result", async () => {
    const sent: any[] = [];
    registerFakeDaemon("user-1", "ubuntu", (payload) => {
      sent.push(payload);
      // Stand in for the daemon: reply on the next tick.
      queueMicrotask(() =>
        realtimeHub.resolveRemoteExecResponse(
          {
            request_id: payload.payload.request_id,
            action: "exec",
            result: { runId: "run-1", status: "completed", exitCode: 0 },
            error: null,
          },
          "user-1",
          "ubuntu",
        ),
      );
    });

    const outcome = await requestRemoteExec({
      userId: "user-1",
      agentHost: "ubuntu",
      action: "exec",
      args: { command: "ls", args: ["."], workspace: "/srv/app" },
      timeoutMs: 1_000,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("remote_exec_request");
    expect(sent[0].payload.action).toBe("exec");
    expect(sent[0].payload.args).toEqual({
      command: "ls",
      args: ["."],
      workspace: "/srv/app",
    });
    expect(sent[0].payload.request_id).toBeTruthy();
    expect(outcome).toEqual({
      ok: true,
      action: "exec",
      result: { runId: "run-1", status: "completed", exitCode: 0 },
    });
  });

  it("maps a daemon-reported error to a remote_error outcome", async () => {
    registerFakeDaemon("user-1", "err-host", (payload) => {
      queueMicrotask(() =>
        realtimeHub.resolveRemoteExecResponse(
          {
            request_id: payload.payload.request_id,
            action: "exec",
            error: "workspace does not exist: /nope",
          },
          "user-1",
          "err-host",
        ),
      );
    });

    const outcome = await requestRemoteExec({
      userId: "user-1",
      agentHost: "err-host",
      action: "exec",
      args: { command: "ls", workspace: "/nope" },
      timeoutMs: 1_000,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: "remote_error",
      message: "workspace does not exist: /nope",
    });
  });

  it("reports agent_offline without waiting when the daemon is not connected", async () => {
    const outcome = await requestRemoteExec({
      userId: "user-1",
      agentHost: "never-connected",
      action: "exec",
      args: { command: "ls" },
      timeoutMs: 1_000,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: "agent_offline",
      message: "daemon never-connected not connected",
    });
  });

  it("times out when the daemon never replies", async () => {
    registerFakeDaemon("user-1", "silent-host", () => {
      // Deliberately no reply.
    });

    const outcome = await requestRemoteExec({
      userId: "user-1",
      agentHost: "silent-host",
      action: "exec",
      args: { command: "ls" },
      timeoutMs: 20,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("fails fast when the daemon disconnects mid-request instead of waiting out the timeout", async () => {
    let conn: any;
    conn = {
      id: "conn-drop-host",
      kind: "agent" as const,
      userId: "user-1",
      projectIds: [],
      host: "drop-host",
      capabilities: ["remote_exec"],
      // Simulate the socket dying the moment the request goes out.
      send: () => realtimeHub.unregister(conn.id),
      close: () => {},
    };
    (realtimeHub as RealtimeHub).register(conn);

    const started = Date.now();
    const outcome = await requestRemoteExec({
      userId: "user-1",
      agentHost: "drop-host",
      action: "exec",
      args: { command: "ls" },
      timeoutMs: 30_000,
    });

    // Reported as offline, not as a timeout: the two need different remedies.
    expect(outcome).toMatchObject({ ok: false, reason: "agent_offline" });
    expect((outcome as { message: string }).message).toMatch(/disconnected before answering/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("rejects further requests once a user has too many in flight", async () => {
    registerFakeDaemon("cap-user", "cap-host", () => {
      // Never replies, so every request stays in flight.
    });

    const pending = Array.from({ length: 8 }, () =>
      requestRemoteExec({
        userId: "cap-user",
        agentHost: "cap-host",
        action: "exec",
        args: { command: "ls" },
        timeoutMs: 300,
      }),
    );

    const overflow = await requestRemoteExec({
      userId: "cap-user",
      agentHost: "cap-host",
      action: "exec",
      args: { command: "ls" },
      timeoutMs: 300,
    });
    expect(overflow).toMatchObject({ ok: false, reason: "too_many_inflight" });

    await Promise.all(pending);

    // Slots are released, so the next request is admitted again.
    const afterDrain = await requestRemoteExec({
      userId: "cap-user",
      agentHost: "cap-host",
      action: "exec",
      args: { command: "ls" },
      timeoutMs: 100,
    });
    expect(afterDrain).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("does not let one user's in-flight requests block another user", async () => {
    registerFakeDaemon("noisy-user", "shared-host", () => {});
    registerFakeDaemon("quiet-user", "quiet-host", (payload) => {
      queueMicrotask(() =>
        realtimeHub.resolveRemoteExecResponse(
          { request_id: payload.payload.request_id, action: "exec", result: { runId: "ok" } },
          "quiet-user",
          "quiet-host",
        ),
      );
    });

    const noisy = Array.from({ length: 8 }, () =>
      requestRemoteExec({
        userId: "noisy-user",
        agentHost: "shared-host",
        action: "exec",
        args: { command: "ls" },
        timeoutMs: 300,
      }),
    );

    const outcome = await requestRemoteExec({
      userId: "quiet-user",
      agentHost: "quiet-host",
      action: "exec",
      args: { command: "ls" },
      timeoutMs: 1_000,
    });
    expect(outcome).toMatchObject({ ok: true });

    await Promise.all(noisy);
  });

  it("ignores a reply forged by another user's daemon and times out instead", async () => {
    registerFakeDaemon("user-1", "victim-host", (payload) => {
      queueMicrotask(() =>
        realtimeHub.resolveRemoteExecResponse(
          {
            request_id: payload.payload.request_id,
            action: "exec",
            result: { hijacked: true },
          },
          "attacker",
          "victim-host",
        ),
      );
    });

    const outcome = await requestRemoteExec({
      userId: "user-1",
      agentHost: "victim-host",
      action: "exec",
      args: { command: "ls" },
      timeoutMs: 20,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "timeout" });
  });
});
